"""Development-only PIV enrollment/proof tool; never an EXMO analysis license."""
import argparse
from datetime import datetime, timezone
import getpass
import hashlib
from importlib.metadata import version
import json
import logging
from pathlib import Path
import secrets
import subprocess
import sys
import time

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from OpenSSL import crypto
from smartcard.ExclusiveConnectCardConnection import ExclusiveConnectCardConnection
from smartcard.pcsc.PCSCExceptions import EstablishContextException
from ykman.pcsc import list_devices, ScardSmartCardConnection
from yubikit.core import Tlv
from yubikit.core.smartcard import ApduError, SW
from yubikit.piv import KEY_TYPE, MANAGEMENT_KEY_TYPE, PIN_POLICY, PivSession, SLOT, TOUCH_POLICY
from yubikit.support import read_info

TRUST = Path(__file__).with_name("trust")
TRUST_FILES = {
    "yubico-ca-1.crt": "9271d914d48d05487666703586aea27d9a69ad0c8ddf8c2fc4c8734a04285887",
    "yubico-piv-ca-1.crt": "6234f33d5f652109d265b391f2898b8ba92f62df406b684db18363f50d7c9129",
    "yubico-intermediate.crt": "ec0172fe38838e3de174aae4e058bb44920be47cebd8d658a0fba1634b82aee1",
}
SLOTS = (SLOT.CARD_AUTH, SLOT.KEY_MANAGEMENT)
SCHEMA = "exmo-piv-enrollment-poc-v1"
PROOF_TTL = 60


class CheckFailed(Exception):
    pass


def require(condition, message):
    if not condition:
        raise CheckFailed(message)


def public_bytes(key):
    return key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def fingerprint(key):
    return hashlib.sha256(public_bytes(key)).hexdigest()


def open_exclusive(device):
    # The SDK's general opener can fall back to shared access or stop other agents.
    return ScardSmartCardConnection(ExclusiveConnectCardConnection(device.reader.createConnection()))


def sdk_versions():
    return {name: version(name) for name in ("yubikey-manager", "cryptography", "pyOpenSSL")}


def load_trust():
    roots, intermediates = [], []
    for name, expected in TRUST_FILES.items():
        data = (TRUST / name).read_bytes()
        require(hashlib.sha256(data).hexdigest() == expected, "Bundled trust file changed")
        certs = x509.load_pem_x509_certificates(data)
        (intermediates if name == "yubico-intermediate.crt" else roots).extend(certs)
    return roots, intermediates


def verify_chain(certificate, chain, roots):
    store = crypto.X509Store()
    for root in roots:
        store.add_cert(crypto.X509.from_cryptography(root))
    store.set_flags(crypto.X509StoreFlags.CHECK_SS_SIGNATURE)
    try:
        context = crypto.X509StoreContext(store, crypto.X509.from_cryptography(certificate),
                                         [crypto.X509.from_cryptography(c) for c in chain])
        context.verify_certificate()
    except crypto.X509StoreContextError as error:
        raise CheckFailed("Attestation chain is not valid under the approved Yubico roots") from error


def extension(certificate, suffix):
    value = certificate.extensions.get_extension_for_oid(x509.ObjectIdentifier(f"1.3.6.1.4.1.41482.3.{suffix}")).value
    require(isinstance(value, x509.UnrecognizedExtension), "Unexpected attestation extension encoding")
    return value.value


def verify_attestation(certificate, factory, slot, serial, version, roots, intermediates):
    verify_chain(certificate, [factory, *intermediates], roots)
    # Require this device's F9 as the immediate issuer, not merely any trusted path.
    certificate.verify_directly_issued_by(factory)
    names = certificate.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
    require(len(names) == 1 and names[0].value == f"YubiKey PIV Attestation {int(slot):02x}", "Wrong attested slot")
    key = certificate.public_key()
    require(isinstance(key, ec.EllipticCurvePublicKey) and isinstance(key.curve, ec.SECP256R1), "Expected a P-256 key")
    encoded_serial = Tlv.unpack(0x02, extension(certificate, 7))
    require(0 < len(encoded_serial) <= 5 and not (encoded_serial[0] & 0x80), "Invalid device serial encoding")
    require(int.from_bytes(encoded_serial, "big") == serial, "Attested serial differs from selected device")
    require(extension(certificate, 3) == bytes(version), "Attested firmware differs from selected device")
    require(extension(certificate, 8) == bytes([PIN_POLICY.NEVER, TOUCH_POLICY.NEVER]), "Expected PIN Never and Touch Never")
    require(extension(certificate, 9) == b"\x04", "Only non-FIPS YubiKey 5C Nano is in this PoC scope")
    return key


def check_device(info):
    require(info.serial is not None and info.serial > 0, "Device has no usable serial")
    require(int(info.form_factor) == 4 and not info.is_fips, "Select a non-FIPS YubiKey 5C Nano")
    require(tuple(info.version) >= (5, 4, 0), "This PoC requires firmware 5.4+ for metadata and AES management keys")


def check_admin_secrets(session):
    pin, puk, management = session.get_pin_metadata(), session.get_puk_metadata(), session.get_management_key_metadata()
    require(not pin.default_value and not puk.default_value and not management.default_value,
            "Replace factory PIN, PUK and management key using the provisioning runbook first")
    require(pin.attempts_remaining > 0 and puk.attempts_remaining > 0, "PIN or PUK is blocked")
    require(management.key_type == MANAGEMENT_KEY_TYPE.AES256, "Use an operator-managed AES256 management key")


def check_empty_slots(session):
    for slot in SLOTS:
        for read in (session.get_slot_metadata, session.get_certificate):
            try:
                read(slot)
            except ApduError as error:
                if error.sw == SW.REFERENCE_DATA_NOT_FOUND:
                    continue
                raise
            raise CheckFailed(f"Slot {int(slot):02x} already contains a key or certificate; no overwrite allowed")


def provision(session, info, management_key, roots, intermediates):
    check_device(info)
    check_admin_secrets(session)
    check_empty_slots(session)
    factory = session.get_certificate(SLOT.ATTESTATION)
    verify_chain(factory, intermediates, roots)
    require(len(management_key) == 32, "AES256 management key must contain 32 bytes")
    session.authenticate(management_key)
    # No reset, import, F9 write, credential change or replacement of occupied slots.
    generated = {}
    for slot in SLOTS:
        key = session.generate_key(slot, KEY_TYPE.ECCP256, PIN_POLICY.NEVER, TOUCH_POLICY.NEVER)
        generated[f"{int(slot):02x}"] = fingerprint(key)
    return {"status": "keys_generated_enrollment_required", "serial": info.serial, "public_key_sha256": generated}


class Challenge:
    def __init__(self, serial, key_fingerprint):
        self.message = (f"EXMO/PIV-POC/v1/{serial}/{key_fingerprint}/".encode("ascii") + secrets.token_bytes(32))
        self.started = time.monotonic()
        self.used = False

    def verify(self, key, signature):
        require(not self.used, "Challenge already consumed")
        self.used = True
        elapsed = time.monotonic() - self.started
        require(0 <= elapsed < PROOF_TTL, "Challenge expired")
        key.verify(signature, self.message, ec.ECDSA(hashes.SHA256()))


def collect_proof(session, info, roots, intermediates):
    check_device(info)
    check_admin_secrets(session)
    factory = session.get_certificate(SLOT.ATTESTATION)
    certificates, keys = {}, {}
    for slot in SLOTS:
        certificate = session.attest_key(slot)
        key = verify_attestation(certificate, factory, slot, info.serial, tuple(info.version), roots, intermediates)
        metadata = session.get_slot_metadata(slot)
        require(metadata.generated and metadata.key_type == KEY_TYPE.ECCP256, "Slot must contain an internally generated P-256 key")
        require(metadata.pin_policy == PIN_POLICY.NEVER and metadata.touch_policy == TOUCH_POLICY.NEVER,
                "Slot metadata disagrees with required policies")
        require(public_bytes(metadata.public_key) == public_bytes(key), "Slot key differs from attested key")
        certificates[slot], keys[slot] = certificate, key
    require(public_bytes(keys[SLOTS[0]]) != public_bytes(keys[SLOTS[1]]), "Authentication and agreement keys must be distinct")
    started = time.perf_counter()
    challenge = Challenge(info.serial, fingerprint(keys[SLOT.CARD_AUTH]))
    signature = session.sign(SLOT.CARD_AUTH, KEY_TYPE.ECCP256, challenge.message, hashes.SHA256())
    challenge.verify(keys[SLOT.CARD_AUTH], signature)
    sign_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    ephemeral = ec.generate_private_key(ec.SECP256R1())
    expected = ephemeral.exchange(ec.ECDH(), keys[SLOT.KEY_MANAGEMENT])
    actual = session.calculate_secret(SLOT.KEY_MANAGEMENT, ephemeral.public_key())
    require(secrets.compare_digest(expected, actual), "ECDH proof does not match the attested key")
    agreement_ms = (time.perf_counter() - started) * 1000
    return {
        "schema": SCHEMA, "status": "hardware_proof_passed_not_a_license",
        "checked_at": datetime.now(timezone.utc).isoformat(), "serial": info.serial,
        "sdk_versions": sdk_versions(),
        "firmware": str(info.version), "form_factor": "USB_C_NANO", "pin_policy": "NEVER", "touch_policy": "NEVER",
        "factory_certificate_pem": factory.public_bytes(serialization.Encoding.PEM).decode("ascii"),
        "slots": {f"{int(slot):02x}": {
            "public_key_sha256": fingerprint(keys[slot]),
            "attestation_pem": certificates[slot].public_bytes(serialization.Encoding.PEM).decode("ascii"),
        } for slot in SLOTS},
        "timings_ms": {"sign_verify": round(sign_ms, 3), "ecdh_verify": round(agreement_ms, 3)},
    }


def compare_registration(record, proof):
    require(record.get("schema") == SCHEMA and record.get("serial") == proof["serial"], "Enrollment belongs to another device")
    for slot in ("9e", "9d"):
        require(record["slots"][slot]["public_key_sha256"] == proof["slots"][slot]["public_key_sha256"],
                f"Enrolled key in slot {slot} was replaced")


def read_record(path):
    with path.open("rb") as stream:
        data = stream.read(65537)
    require(len(data) <= 65536, "Enrollment record is too large")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate enrollment field")
            result[key] = value
        return result
    value = json.loads(data, object_pairs_hook=unique)
    require(isinstance(value, dict), "Enrollment must be a JSON object")
    return value


def operate(args):
    roots, intermediates = load_trust()
    devices = []
    for device in list_devices():
        with open_exclusive(device) as connection:
            devices.append((device, read_info(connection, device.pid)))
    if args.command == "inventory":
        return {"status": "devices_found" if devices else "hardware_not_connected",
                "sdk_versions": sdk_versions(),
                "devices": [{"serial": i.serial, "firmware": str(i.version), "form_factor": str(i.form_factor)} for _, i in devices]}
    chosen = [(d, i) for d, i in devices if i.serial == args.serial]
    require(len(chosen) == 1, "Expected exactly one connected PIV device matching --serial")
    device, info = chosen[0]
    with open_exclusive(device) as connection:
        info = read_info(connection, device.pid)
        require(info.serial == args.serial, "Device changed during selection")
        session = PivSession(connection)
        if args.command == "provision":
            key = bytes.fromhex(sys.stdin.readline(128).strip())
            return provision(session, info, key, roots, intermediates)
        proof = collect_proof(session, info, roots, intermediates)
    if args.command == "verify":
        compare_registration(read_record(args.record), proof)
    if args.command == "enroll":
        # Exclusive creation preserves an existing enrollment and never overwrites a key record.
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(proof, stream, indent=2)
            stream.write("\n")
    return {"status": proof["status"], "serial": proof["serial"], "firmware": proof["firmware"],
            "sdk_versions": proof["sdk_versions"],
            "timings_ms": proof["timings_ms"], "public_key_sha256": {k: v["public_key_sha256"] for k, v in proof["slots"].items()}}


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hardware-worker", action="store_true", help=argparse.SUPPRESS)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("inventory", help="Read connected PIV devices without modifying them")
    for name in ("provision", "enroll", "verify"):
        command = commands.add_parser(name)
        command.add_argument("--serial", type=int, required=True)
        if name == "enroll":
            command.add_argument("--output", type=Path, required=True)
        if name == "verify":
            command.add_argument("--record", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    args = parse_args(argv)
    logging.disable(logging.CRITICAL)
    if not args.hardware_worker:
        secret = ""
        if args.command == "provision":
            require(sys.stdin.isatty(), "Provisioning requires an interactive terminal")
            require(input(f"Generate NEW keys in empty slots 9E/9D on device {args.serial}. Type its serial: ") == str(args.serial),
                    "Provisioning cancelled")
            secret = getpass.getpass("Existing non-default AES256 management key (hex, hidden): ") + "\n"
        # PC/SC calls can hang in a native driver. Bound the entire helper, including discovery.
        try:
            completed = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--hardware-worker", *argv],
                                       input=secret, capture_output=True, text=True, encoding="utf-8", timeout=60)
        except subprocess.TimeoutExpired:
            print(json.dumps({"status": "failed", "error": "Hardware timeout; inspect slots before retrying provisioning"}))
            return 2
        if completed.returncode not in (0, 2) or not completed.stdout.strip():
            print(json.dumps({"status": "failed", "error": "Hardware helper failed; no enrollment accepted"}))
            return 2
        print(completed.stdout.strip())
        return completed.returncode
    try:
        result = operate(args)
        print(json.dumps(result))
        return 2 if result["status"] == "hardware_not_connected" else 0
    except CheckFailed as error:
        print(json.dumps({"status": "failed", "error": str(error)}))
    except EstablishContextException:
        print(json.dumps({"status": "pcsc_unavailable", "sdk_versions": sdk_versions(),
                          "error": "Cannot access PC/SC; check Smart Card service and driver. No hardware proof performed."}))
    except Exception as error:
        # Never echo SDK inputs, management keys or partially decrypted material.
        print(json.dumps({"status": "failed", "error": type(error).__name__, "detail": "PIV verification did not complete"}))
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (CheckFailed, KeyboardInterrupt, EOFError) as error:
        print(json.dumps({"status": "failed", "error": str(error) if isinstance(error, CheckFailed) else "Cancelled"}))
        sys.exit(2)
