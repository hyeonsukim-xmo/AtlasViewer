import { useEffect, useState } from "react";
import { useLanguage } from "./language";
import type { LicenseStatus } from "./imaging";

export default function LicenseStatusButton() {
  const language = useLanguage();
  const [status, setStatus] = useState<LicenseStatus>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let mounted = true;
    const update = () => window.exmoDesktop.licenseStatus().then(value => {
      if (mounted) setStatus(value);
    }).catch(() => {});
    void update();
    const timer = setInterval(() => void update(), 5000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  if (!status || status.profile === "development") return null;
  const permitted = status.state === "VALID" || status.state === "GRACE";
  const product = status.profile === 'internal' ? (language === 'ko' ? '내부 개발용' : 'Internal') : (language === 'ko' ? '라이선스' : 'License');
  const label = language === "ko"
    ? `${product} · ${status.state === "VALID" ? "인증됨" : status.state === "GRACE" ? "오프라인 유예" : "승인 필요"}`
    : `${product} · ${status.state === "VALID" ? "Authorized" : status.state === "GRACE" ? "Offline grace" : "Approval required"}`;
  return <button className="license-status" data-permitted={permitted} disabled={busy}
    title={status.state} aria-label={language === "ko" ? `라이선스 관리: ${label}` : `Manage license: ${label}`}
    onClick={async () => {
      setBusy(true);
      try { setStatus(await window.exmoDesktop.manageLicense()); } finally { setBusy(false); }
    }}>{label}</button>;
}
