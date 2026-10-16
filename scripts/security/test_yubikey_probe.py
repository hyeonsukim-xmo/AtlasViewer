"""Synthetic certificates exercise rejection paths; they do not attest real hardware."""
from datetime import datetime, timedelta, timezone
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from yubikit.core import Tlv, Version
from yubikit.core.smartcard import ApduError, SW
from yubikit.piv import KEY_TYPE, MANAGEMENT_KEY_TYPE, PIN_POLICY, SLOT, TOUCH_POLICY

import yubikey_probe as probe
import piv_support


def certificate(subject, key, issuer, issuer_key, *, ca=False, expired=False, extensions=()):
    now = datetime.now(timezone.utc)
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, subject)])
    builder = (x509.CertificateBuilder().subject_name(name).issuer_name(issuer or name)
               .public_key(key.public_key()).serial_number(x509.random_serial_number())
               .not_valid_before(now - timedelta(days=3))
               .not_valid_after(now + timedelta(days=-1 if expired else 3))
               .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
               .add_extension(x509.KeyUsage(True, False, False, False, False, ca, ca, False, False), critical=True))
    for suffix, value in extensions:
        builder = builder.add_extension(x509.UnrecognizedExtension(x509.ObjectIdentifier(f"1.3.6.1.4.1.41482.3.{suffix}"), value), critical=False)
    return builder.sign(issuer_key, hashes.SHA256())


class FakeSession:
    def __init__(self, fixture):
        self.fixture = fixture
        self.keys = {s: ec.generate_private_key(ec.SECP256R1()) for s in probe.SLOTS}
        self.present = set(probe.SLOTS)
        self.certificates_present = set()
        self.default_pin = self.default_puk = self.default_management = False
        self.generated = True
        self.pin_policy = PIN_POLICY.NEVER
        self.touch_policy = TOUCH_POLICY.NEVER
        self.writes = []

    def get_pin_metadata(self):
        return SimpleNamespace(default_value=self.default_pin, attempts_remaining=3)

    def get_puk_metadata(self):
        return SimpleNamespace(default_value=self.default_puk, attempts_remaining=3)

    def get_management_key_metadata(self):
        return SimpleNamespace(default_value=self.default_management, key_type=MANAGEMENT_KEY_TYPE.AES256)

    def get_slot_metadata(self, slot):
        if slot not in self.present:
            raise ApduError(b"", SW.REFERENCE_DATA_NOT_FOUND)
        return SimpleNamespace(generated=self.generated, key_type=KEY_TYPE.ECCP256,
                               pin_policy=self.pin_policy, touch_policy=self.touch_policy,
                               public_key=self.keys[slot].public_key())

    def get_certificate(self, slot):
        if slot == SLOT.ATTESTATION:
            return self.fixture.factory
        if slot not in self.certificates_present:
            raise ApduError(b"", SW.REFERENCE_DATA_NOT_FOUND)
        return self.attest_key(slot)

    def attest_key(self, slot):
        return self.fixture.attest(slot, self.keys[slot])

    def sign(self, slot, key_type, message, hash_algorithm):
        return self.keys[slot].sign(message, ec.ECDSA(hash_algorithm))

    def calculate_secret(self, slot, peer):
        return self.keys[slot].exchange(ec.ECDH(), peer)

    def authenticate(self, key):
        self.writes.append("authenticate")

    def generate_key(self, slot, algorithm, pin, touch):
        assert slot not in self.present
        assert (algorithm, pin, touch) == (KEY_TYPE.ECCP256, PIN_POLICY.NEVER, TOUCH_POLICY.NEVER)
        self.writes.append(slot)
        self.present.add(slot)
        return self.keys[slot].public_key()


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.root_key = ec.generate_private_key(ec.SECP256R1())
        self.root = certificate("Test root only", self.root_key, None, self.root_key, ca=True)
        self.factory_key = ec.generate_private_key(ec.SECP256R1())
        self.factory = certificate("Test F9 only", self.factory_key, self.root.subject, self.root_key, ca=True)
        self.info = SimpleNamespace(serial=12345678, version=Version(5, 7, 4), form_factor=4, is_fips=False)
        self.session = FakeSession(self)

    def attest(self, slot, key, **changes):
        extensions = {3: bytes(self.info.version), 7: bytes(Tlv(0x02, self.info.serial.to_bytes(4, "big"))),
                      8: b"\x01\x01", 9: bytes([int(self.info.form_factor)])}
        extensions.update(changes.pop("extensions", {}))
        return certificate(changes.pop("subject", f"YubiKey PIV Attestation {int(slot):02x}"),
                           key, self.factory.subject, changes.pop("issuer_key", self.factory_key),
                           extensions=extensions.items(), **changes)

    def verify(self, cert):
        return probe.verify_attestation(cert, self.factory, SLOT.CARD_AUTH, self.info.serial,
                                        tuple(self.info.version), [self.root], [])

    def test_valid_chain_sign_ecdh_and_registration(self):
        proof = probe.collect_proof(self.session, self.info, [self.root], [])
        self.assertEqual(proof["status"], "hardware_proof_passed_not_a_license")
        self.assertEqual(set(proof["slots"]), {"9e", "9d"})
        probe.compare_registration(proof, proof)
        self.assertNotIn("PRIVATE KEY", json.dumps(proof))
        self.assertEqual(self.session.writes, [])

    def test_nfc_58_and_nano_54_use_the_same_verified_enrollment(self):
        for form_factor, version in [(3, Version(5, 8, 0)), (4, Version(5, 4, 0))]:
            with self.subTest(form_factor=form_factor):
                self.info.form_factor, self.info.version = form_factor, version
                proof = probe.collect_proof(self.session, self.info, [self.root], [])
                self.assertEqual(proof['form_factor'], probe.FORM_FACTORS[form_factor])
                record = {'serial': self.info.serial, 'firmware': list(version),
                          'factoryCertificate': proof['factory_certificate_pem'],
                          'attestations': {s: v['attestation_pem'] for s, v in proof['slots'].items()}}
                with patch.object(piv_support, 'load_trust', return_value=([self.root], [])):
                    self.assertEqual(set(piv_support.verify_record(record)), {'9e', '9d'})
                    self.assertEqual(set(piv_support.verify_record(record, form_factor)), {'9e', '9d'})
                    with self.assertRaises(probe.CheckFailed):
                        piv_support.verify_record(record, 7 - form_factor)
                self.assertEqual(self.session.writes, [])

    def test_form_factor_mismatch_and_unsupported_devices_are_rejected(self):
        self.info.form_factor = 3
        wrong = self.attest(SLOT.CARD_AUTH, self.session.keys[SLOT.CARD_AUTH], extensions={9: b'\x04'})
        with patch.object(self.session, 'attest_key', return_value=wrong), self.assertRaises(probe.CheckFailed):
            probe.collect_proof(self.session, self.info, [self.root], [])
        for factor in (0, 1, 2, 5, 0x83, 0x84):
            self.info.form_factor = factor
            with self.subTest(factor=factor), self.assertRaises(probe.CheckFailed):
                probe.check_device(self.info)
        self.info.form_factor, self.info.is_fips = 3, True
        with self.assertRaises(probe.CheckFailed):
            probe.check_device(self.info)
        self.info.is_fips, self.info.version = False, Version(5, 3, 0)
        with self.assertRaises(probe.CheckFailed):
            probe.check_device(self.info)

    def test_both_attested_slots_must_have_the_same_form_factor(self):
        self.info.form_factor = 3
        record = {'serial': self.info.serial, 'firmware': list(self.info.version),
                  'factoryCertificate': self.factory.public_bytes(probe.serialization.Encoding.PEM).decode(),
                  'attestations': {f'{int(s):02x}': self.attest(s, self.session.keys[s],
                      extensions={9: bytes([3 if s == SLOT.CARD_AUTH else 4])})
                      .public_bytes(probe.serialization.Encoding.PEM).decode() for s in probe.SLOTS}}
        with patch.object(piv_support, 'load_trust', return_value=([self.root], [])), self.assertRaises(probe.CheckFailed):
            piv_support.verify_record(record)

    def test_bundled_trust_is_pinned_and_has_no_test_roots(self):
        roots, intermediates = probe.load_trust()
        self.assertEqual(len(roots), 2)
        self.assertGreater(len(intermediates), 0)
        for root in roots:
            probe.verify_chain(root, [], roots)
        with self.assertRaises(probe.CheckFailed):
            probe.verify_chain(self.factory, intermediates, roots)
        with patch.dict(probe.TRUST_FILES, {"yubico-ca-1.crt": "0" * 64}):
            with self.assertRaises(probe.CheckFailed):
                probe.load_trust()

    def test_wrong_issuer_and_expired_certificate(self):
        key = self.session.keys[SLOT.CARD_AUTH]
        rogue = ec.generate_private_key(ec.SECP256R1())
        for cert in (self.attest(SLOT.CARD_AUTH, key, issuer_key=rogue), self.attest(SLOT.CARD_AUTH, key, expired=True)):
            with self.subTest(cert=cert.serial_number), self.assertRaises(probe.CheckFailed):
                self.verify(cert)

    def test_identity_policy_and_slot_binding(self):
        key = self.session.keys[SLOT.CARD_AUTH]
        cases = [{"subject": "YubiKey PIV Attestation 9d"},
                 {"extensions": {7: bytes(Tlv(0x02, b"\x01"))}},
                 {"extensions": {7: bytes(Tlv(0x02, b"\xff"))}},
                 {"extensions": {3: b"\x05\x06\x00"}},
                 {"extensions": {8: b"\x02\x01"}},
                 {"extensions": {8: b"\x01\x02"}},
                 {"extensions": {9: b"\x84"}}]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(probe.CheckFailed):
                self.verify(self.attest(SLOT.CARD_AUTH, key, **case))
        with self.assertRaises(probe.CheckFailed):
            self.verify(self.attest(SLOT.CARD_AUTH, ec.generate_private_key(ec.SECP384R1())))

    def test_intermediate_chain(self):
        intermediate_key = ec.generate_private_key(ec.SECP256R1())
        intermediate = certificate("Test intermediate", intermediate_key, self.root.subject, self.root_key, ca=True)
        self.factory = certificate("Test F9", self.factory_key, intermediate.subject, intermediate_key, ca=True)
        cert = self.session.attest_key(SLOT.CARD_AUTH)
        probe.verify_attestation(cert, self.factory, SLOT.CARD_AUTH, self.info.serial, tuple(self.info.version), [self.root], [intermediate])
        with self.assertRaises(probe.CheckFailed):
            self.verify(cert)

    def test_challenge_replay_wrong_key_and_expiry(self):
        key = self.session.keys[SLOT.CARD_AUTH]
        challenge = probe.Challenge(self.info.serial, probe.fingerprint(key.public_key()))
        signature = key.sign(challenge.message, ec.ECDSA(hashes.SHA256()))
        challenge.verify(key.public_key(), signature)
        with self.assertRaises(probe.CheckFailed):
            challenge.verify(key.public_key(), signature)
        fresh = probe.Challenge(self.info.serial, probe.fingerprint(key.public_key()))
        with self.assertRaises(InvalidSignature):
            fresh.verify(key.public_key(), signature)
        for elapsed in (-1, probe.PROOF_TTL, probe.PROOF_TTL + 1):
            challenge = probe.Challenge(self.info.serial, probe.fingerprint(key.public_key()))
            with patch.object(probe.time, "monotonic", return_value=challenge.started + elapsed):
                with self.assertRaises(probe.CheckFailed):
                    challenge.verify(key.public_key(), signature)

    def test_imported_key_metadata_and_ecdh_failure(self):
        self.session.generated = False
        with self.assertRaises(probe.CheckFailed):
            probe.collect_proof(self.session, self.info, [self.root], [])
        self.session.generated = True
        with patch.object(self.session, "calculate_secret", return_value=b"\0" * 32):
            with self.assertRaises(probe.CheckFailed):
                probe.collect_proof(self.session, self.info, [self.root], [])

    def test_record_rejects_replaced_key_or_different_device(self):
        proof = probe.collect_proof(self.session, self.info, [self.root], [])
        for slot in ("9e", "9d"):
            other = json.loads(json.dumps(proof))
            other["slots"][slot]["public_key_sha256"] = "0" * 64
            with self.assertRaises(probe.CheckFailed):
                probe.compare_registration(other, proof)
        other = {**proof, "serial": proof["serial"] + 1}
        with self.assertRaises(probe.CheckFailed):
            probe.compare_registration(other, proof)

    def test_provision_writes_only_empty_slots_after_all_checks(self):
        self.session.present.clear()
        result = probe.provision(self.session, self.info, b"K" * 32, [self.root], [])
        self.assertEqual(result["status"], "keys_generated_enrollment_required")
        self.assertEqual(self.session.writes, ["authenticate", SLOT.CARD_AUTH, SLOT.KEY_MANAGEMENT])

    def test_no_overwrite_or_default_admin_credentials(self):
        for existing_slot in probe.SLOTS:
            self.session.present = {existing_slot}
            with self.assertRaises(probe.CheckFailed):
                probe.provision(self.session, self.info, b"K" * 32, [self.root], [])
            self.assertEqual(self.session.writes, [])
        self.session.present.clear()
        self.session.certificates_present = {SLOT.KEY_MANAGEMENT}
        with self.assertRaises(probe.CheckFailed):
            probe.provision(self.session, self.info, b"K" * 32, [self.root], [])
        self.session.certificates_present.clear()
        for field in ("default_pin", "default_puk", "default_management"):
            setattr(self.session, field, True)
            with self.assertRaises(probe.CheckFailed):
                probe.provision(self.session, self.info, b"K" * 32, [self.root], [])
            setattr(self.session, field, False)
        self.assertEqual(self.session.writes, [])

    def test_json_rejects_duplicate_fields_and_oversize(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "record.json"
            for value in ('{"serial":1,"serial":2}', "x" * 65537, "[]"):
                path.write_text(value, encoding="utf-8")
                with self.assertRaises(probe.CheckFailed):
                    probe.read_record(path)

    def test_missing_device_and_hardware_timeout_are_not_success(self):
        with patch.object(probe, "list_devices", return_value=[]):
            self.assertEqual(probe.operate(probe.parse_args(["inventory"]))["status"], "hardware_not_connected")
            with self.assertRaises(probe.CheckFailed):
                probe.operate(probe.parse_args(["verify", "--serial", "12345678", "--record", "unused.json"]))
        with patch.object(probe.subprocess, "run", side_effect=subprocess.TimeoutExpired("probe", 60)):
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(probe.main(["inventory"]), 2)
            self.assertEqual(json.loads(output.getvalue())["status"], "failed")

    def test_exclusive_connection_does_not_fall_back_to_general_opener(self):
        from unittest.mock import Mock
        device = Mock()
        with patch.object(probe, "ScardSmartCardConnection", side_effect=RuntimeError("busy")):
            with patch.object(probe, "ExclusiveConnectCardConnection"):
                with self.assertRaises(RuntimeError):
                    probe.open_exclusive(device)
        device.open_connection.assert_not_called()

    def test_pcsc_service_failure_is_not_reported_as_empty_inventory(self):
        with patch.object(probe, "list_devices", side_effect=probe.EstablishContextException(-2146435043)):
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(probe.main(["--hardware-worker", "inventory"]), 2)
            self.assertEqual(json.loads(output.getvalue())["status"], "pcsc_unavailable")


if __name__ == "__main__":
    unittest.main()
