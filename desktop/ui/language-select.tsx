import { setLanguage, t, useLanguage, type Language } from "./language";

export default function LanguageSelect() {
  const language = useLanguage();
  return (
    <label className="language-select" data-language-switch>
      <span>Language</span>
      <select
        aria-label={t("언어")}
        value={language}
        onChange={(event) => setLanguage(event.target.value as Language)}
      >
        <option value="ko">한국어</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}
