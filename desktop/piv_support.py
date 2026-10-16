"""Pinned PIV attestation verification shared by enrollment and the desktop runtime."""
import hashlib
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from OpenSSL import crypto
from yubikit.core import Tlv
from yubikit.piv import KEY_TYPE, MANAGEMENT_KEY_TYPE, PIN_POLICY, SLOT, TOUCH_POLICY

TRUST = Path(__file__).with_name("trust")
if not TRUST.exists():
    TRUST = Path(__file__).resolve().parents[1] / "scripts/security/trust"
TRUST_FILES = {
    "yubico-ca-1.crt": "9271d914d48d05487666703586aea27d9a69ad0c8ddf8c2fc4c8734a04285887",
    "yubico-piv-ca-1.crt": "6234f33d5f652109d265b391f2898b8ba92f62df406b684db18363f50d7c9129",
    "yubico-intermediate.crt": "ec0172fe38838e3de174aae4e058bb44920be47cebd8d658a0fba1634b82aee1",
}
SLOTS = (SLOT.CARD_AUTH, SLOT.KEY_MANAGEMENT)
SCHEMA = "exmo-piv-enrollment-poc-v1"
PROOF_TTL = 60
FORM_FACTORS = {3: "USB_C_KEYCHAIN", 4: "USB_C_NANO"}

class CheckFailed(Exception):
    pass


def require(condition, message):
    if not condition:
        raise CheckFailed(message)


def public_bytes(key):
    return key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def fingerprint(key):
    return hashlib.sha256(public_bytes(key)).hexdigest()


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


def verify_attestation(certificate, factory, slot, serial, version, roots, intermediates, form_factor=None):
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
    attested_form = extension(certificate, 9)
    require(len(attested_form) == 1 and attested_form[0] in FORM_FACTORS,
            "Expected a non-FIPS YubiKey 5C NFC or 5C Nano form factor")
    require(form_factor is None or attested_form[0] == form_factor, "Attested form factor differs from selected device")
    return key


def check_device(info):
    require(info.serial is not None and info.serial > 0, "Device has no usable serial")
    require(int(info.form_factor) in FORM_FACTORS and not info.is_fips, "Select a non-FIPS YubiKey 5C NFC or 5C Nano")
    require(tuple(info.version) >= (5, 4, 0), "This PoC requires firmware 5.4+ for metadata and AES management keys")


def check_admin_secrets(session):
    pin, puk, management = session.get_pin_metadata(), session.get_puk_metadata(), session.get_management_key_metadata()
    require(not pin.default_value and not puk.default_value and not management.default_value,
            "Replace factory PIN, PUK and management key using the provisioning runbook first")
    require(pin.attempts_remaining > 0 and puk.attempts_remaining > 0, "PIN or PUK is blocked")
    require(management.key_type == MANAGEMENT_KEY_TYPE.AES256, "Use an operator-managed AES256 management key")


def verify_record(record, form_factor=None):
    require(isinstance(record, dict) and set(record) == {'serial', 'firmware', 'factoryCertificate', 'attestations'}, 'Invalid hardware enrollment')
    require(type(record['serial']) is int and 0 < record['serial'] < 2 ** 32, 'Invalid serial')
    version = record['firmware']
    require(isinstance(version, list) and len(version) == 3 and all(type(v) is int and 0 <= v <= 255 for v in version) and tuple(version) >= (5, 4, 0), 'Unsupported firmware')
    require(set(record['attestations']) == {'9e', '9d'}, 'Both PIV keys are required')
    roots, intermediates = load_trust()
    factory = x509.load_pem_x509_certificate(record['factoryCertificate'].encode())
    verify_chain(factory, intermediates, roots)
    keys = {}
    for slot in SLOTS:
        name = f'{int(slot):02x}'
        certificate = x509.load_pem_x509_certificate(record['attestations'][name].encode())
        keys[name] = verify_attestation(certificate, factory, slot, record['serial'], tuple(version), roots, intermediates, form_factor)
        form_factor = extension(certificate, 9)[0]
    require(public_bytes(keys['9e']) != public_bytes(keys['9d']), 'Hardware keys must be distinct')
    return keys
