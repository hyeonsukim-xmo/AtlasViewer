import type { AnalysisResult, ImagingFile } from "./imaging";

// A date is not a study identity: two examinations can occur on the same day.
export function studyAnalysisHistory(files: ImagingFile[], results: AnalysisResult[]) {
  const studyKey = (file: ImagingFile | AnalysisResult) => file.metadata?.studyUid?.trim()
    ? JSON.stringify([file.analysis, file.metadata.studyUid.trim()]) : "";
  const seriesKey = (file: ImagingFile | AnalysisResult) => studyKey(file) && file.metadata?.seriesUid?.trim()
    ? JSON.stringify([studyKey(file), file.metadata.seriesUid.trim()]) : "";
  const inputs = new Set(results.map(result => JSON.stringify([result.analysis, result.inputId])));
  const direct = (file: ImagingFile) => inputs.has(JSON.stringify([file.analysis, file.id]));
  const studies = new Set([...results.map(studyKey), ...files.filter(direct).map(studyKey)].filter(Boolean));
  const series = new Set([...results.map(seriesKey), ...files.filter(direct).map(seriesKey)].filter(Boolean));
  return {
    analyzedInputs: new Set(files.filter(file => direct(file) || studies.has(studyKey(file))).map(file => file.id)),
    completedInputs: new Set(files.filter(file => direct(file) || series.has(seriesKey(file))).map(file => file.id)),
  };
}

export function patientIdentifier(value?: string) {
  const text = value?.trim() || "";
  return /^(anonymous|anonymized|anonymised|anon|unknown|n\/a|null|none|익명|미상)$/i.test(text) ? "" : text;
}
export function studyDate(value?: string) {
  const digits = value?.replaceAll("-", "") || "";
  if (!/^\d{8}$/.test(digits)) return "";
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
  const date = new Date(iso + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : "";
}
export type DateGroup = { key: string; date: string; items: ImagingFile[] };
export type PatientGroup = { key: string; patientId: string; issuer: string; name: string; items: ImagingFile[]; dates: DateGroup[] };
export function seriesLabel(file: {name: string; metadata?: {seriesDescription?: string}}) {
  // Display only. Never use a shortened filename as patient/date evidence.
  const raw = file.metadata?.seriesDescription || file.name;
  return raw.replace(/\.nii\.gz$|\.(nrrd|nii|dcm)$/i, "").replace(/_?\d+(?:\.\d+){5,}.*$/, "")
    .replace(/__AN_.*$/, "").replace(/\s+/g, " ").trim().slice(0, 100) || file.name.slice(0, 100);
}
export function groupPatients(files: ImagingFile[]): PatientGroup[] {
  const patients = new Map<string, PatientGroup>();
  for (const file of files) {
    const m = file.metadata;
    const patientId = patientIdentifier(m?.patientId);
    const issuer = patientIdentifier(m?.patientIssuer) || patientIdentifier(m?.institutionName);
    // Unidentified is an organizational bucket, NOT an inferred shared patient identity.
    const key = !m && !file.ready ? "import-failed" : patientId ? JSON.stringify(issuer ? [issuer, patientId] : ["unscoped", patientId, m?.studyUid || file.id]) : "unidentified";
    if (!patients.has(key)) patients.set(key, {key, patientId, issuer, name: m?.caseName === file.name ? "" : patientIdentifier(m?.caseName), items: [], dates: []});
    const patient = patients.get(key)!;
    patient.items.push(file);
    const date = studyDate(m?.studyDate);
    let group = patient.dates.find(group => group.date === date);
    if (!group) {group = {key: JSON.stringify([key, date]), date, items: []}; patient.dates.push(group);}
    group.items.push(file);
  }
  for (const patient of patients.values()) patient.dates.sort((a, b) => b.date.localeCompare(a.date));
  return [...patients.values()].sort((a, b) => Number(a.key === "import-failed") - Number(b.key === "import-failed") || Number(!a.patientId) - Number(!b.patientId) ||
    a.patientId.localeCompare(b.patientId, undefined, {numeric: true}) || a.issuer.localeCompare(b.issuer));
}
