import type { AnalysisResult, ImagingFile, Metadata } from "./imaging";

export const XRAY_VIEWS = ["LAT_LT", "AP", "LAT_RT"] as const;
export type XrayView = (typeof XRAY_VIEWS)[number];
export type StudyItem = {
  id: string;
  inputId?: string;
  name: string;
  metadata?: Metadata;
  route?: string | null;
  classification?: ImagingFile["classification"];
};
export type XrayStudy<T extends StudyItem> = { key: string; items: T[]; metadata?: Metadata };
export function xrayView(item: StudyItem): XrayView | null {
  const value = (item.route ?? item.classification?.route_to_segmentation)?.replaceAll("-", "_");
  return XRAY_VIEWS.find((view) => view === value) ?? null;
}
export const viewLabel = (view: XrayView) =>
  view === "LAT_LT" ? "LT" : view === "LAT_RT" ? "RT" : "AP";
export function studyIdentity(metadata?: Metadata) {
  return metadata?.studyAssignment ?? metadata;
}
export function studyKey(item: StudyItem): string {
  const m = item.metadata;
  const identity = studyIdentity(m);
  const patient = identity?.patientId?.trim();
  const date = identity?.studyDate?.replaceAll("-", "");
  const issuer = identity?.patientIssuer?.trim() || m?.institutionName?.trim();
  const parsedDate =
    date && /^[0-9]{8}$/.test(date)
      ? new Date(date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8) + "T00:00:00Z")
      : null;
  const validDate =
    parsedDate &&
    Number.isFinite(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10).replaceAll("-", "") === date;
  // Only an explicit assignment merges separate acquisitions on the same day.
  if (m?.studyAssignment && patient && validDate && issuer)
    return JSON.stringify(["patient-day", issuer || "study:" + m!.studyUid, patient, date]);
  if (m?.studyUid && !m.studyAssignment)
    return JSON.stringify(["study", issuer || "", patient || "", m.studyUid]);
  return JSON.stringify(["ungrouped", item.inputId || item.id]);
}
export function groupXrays<T extends StudyItem>(items: T[]): XrayStudy<T>[] {
  const groups = new Map<string, XrayStudy<T>>();
  for (const item of items) {
    const key = studyKey(item);
    if (!groups.has(key)) groups.set(key, { key, metadata: item.metadata, items: [] });
    groups.get(key)!.items.push(item);
  }
  for (const group of groups.values())
    group.items.sort((a, b) => {
      const rank = (item: T) => {
        const view = xrayView(item);
        return view ? XRAY_VIEWS.indexOf(view) : 3;
      };
      return (
        rank(a) - rank(b) ||
        (a.metadata?.acquisitionTime || "").localeCompare(b.metadata?.acquisitionTime || "") ||
        a.id.localeCompare(b.id)
      );
    });
  return [...groups.values()];
}
export function comparisonView(groups: XrayStudy<StudyItem>[]): XrayView {
  const candidates: XrayView[] = ["AP", "LAT_LT", "LAT_RT"];
  const hasView = (group: XrayStudy<StudyItem>, view: XrayView) =>
    group.items.some((item) => xrayView(item) === view);
  return (
    candidates.find((view) => groups.length > 0 && groups.every((group) => hasView(group, view))) ??
    candidates.find((view) => groups.some((group) => hasView(group, view))) ??
    "AP"
  );
}
export function pendingXrayInputs(files: ImagingFile[], results: AnalysisResult[], ids: string[]) {
  return files.filter((file) => file.ready && xrayView(file) && ids.includes(file.id) && !xrayResultFor(file, results));
}
export function xrayResultFor(file: ImagingFile, results: AnalysisResult[]) {
  return results.find(result => result.inputId === file.id || (file.metadata?.studyUid && file.metadata?.sopUid &&
    result.metadata?.studyUid === file.metadata.studyUid && result.metadata?.sopUid === file.metadata.sopUid));
}
export function xrayHistory(files: ImagingFile[], results: AnalysisResult[]) {
  const studies = new Set([...results.map(studyKey), ...files.filter(file => xrayResultFor(file, results)).map(studyKey)]);
  return new Set(files.filter(file => studies.has(studyKey(file))).map(file => file.id));
}
export function xrayApplicable(result: AnalysisResult, row: AnalysisResult["rows"][number]) {
  if (row.applicable != null) return row.applicable;
  // Backward compatibility with delivered LAT recipes whose inactive labels were saved as zero.
  return !result.route?.startsWith("LAT") || ![4, 5, 8, 9].includes(row.label);
}
