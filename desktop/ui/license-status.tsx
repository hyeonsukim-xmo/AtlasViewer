import { useEffect, useState } from "react";
import { t, useLanguage } from "./language";
import type { LicenseStatus } from "./imaging";

export default function LicenseStatusButton() {
  useLanguage();
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
  const product = status.profile === 'internal' ? t('내부 개발용') : t('라이선스');
  const label = `${product} · ${status.state === 'VALID' ? t('인증됨') : status.state === 'GRACE' ? t('오프라인 유예') : t('승인 필요')}`;
  return <button className="license-status" data-permitted={permitted} disabled={busy}
    title={status.state} aria-label={t('라이선스 관리: {{label}}', {label})}
    onClick={async () => {
      setBusy(true);
      try { setStatus(await window.exmoDesktop.manageLicense()); } finally { setBusy(false); }
    }}>{label}</button>;
}
