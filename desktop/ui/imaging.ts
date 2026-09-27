import type { Group } from "../../app/anatomy";
export type Analysis = "ct" | "mri" | "xray";
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export type ModelStatus = {
  reviewAvailable: boolean;
  estimationAvailable: boolean;
  device: string;
};
export type Metadata = {
  format: string;
  caseName: string;
  studyDescription: string;
  seriesDescription: string;
  studyDate?: string;
  size: number[];
  spacing: number[];
  slices: number;
};
export type Classification = {
  predicted_label: string;
  route_to_segmentation: string | null;
  confidence: number;
  probabilities: Record<string, number>;
};
export type ImagingFile = {
  id: string;
  name: string;
  analysis: Analysis;
  metadata?: Metadata;
  ready: boolean;
  confirmation?: "hu" | "water";
  classification?: Classification;
  warnings: string[];
  error?: string;
};
export type PreviewOptions = {
  view?: "axial" | "coronal" | "sagittal";
  index?: number | null;
  window?: "soft" | "bone";
  classIds?: number[] | null;
  side?: "all" | AnatomicalSide;
  opacity?: number;
};
export type AnatomicalSide = "left" | "right" | "unassigned";
export type SideMetric = {
  count: number;
  value: number;
  fat: number | null;
  hu: number | null;
  entropy: number | null;
};
export type Preview = {
  image: string;
  index: number;
  count: number;
  view: string;
  sides: string[];
  metadata: Metadata;
  warnings: string[];
};
export type MetricRow = {
  id: string;
  label: number;
  name: string;
  group: Group;
  color: string;
  count: number;
  value: number;
  rawValue?: number;
  fat: number | null;
  hu: number | null;
  entropy: number | null;
  components: number | null;
  present: boolean;
  sides?: Record<AnatomicalSide, SideMetric> & {
    differenceCm3: number | null;
    differencePercent: number | null;
    flags: string[];
  };
};
export type AnalysisResult = {
  id: string;
  inputId: string;
  analysis: Analysis;
  name: string;
  metadata: Metadata;
  rows: MetricRow[];
  unit: string;
  variant: string;
  route: string | null;
  meshBytes: number | null;
  laterality: {
    method: string;
    status: "estimated" | "partial" | "unavailable";
    reason: string;
    unassignedCm3: number;
  } | null;
  parts?: {
    id: string;
    structureId: string;
    side: AnatomicalSide;
    label: number;
    name: string;
    color: string;
    group: Group;
  }[];
  qc: {
    flags: string[];
    entropy: number | null;
    ttaDisagreement: number | null;
    missing: number[];
    unexpected: number[];
    tta: string;
    postprocessing?: { removedCm3: number; removedPercent: number; changedVoxels: number };
  };
  seconds: number;
  createdAt: string;
};
export type Job = {
  id: string;
  analysis: Analysis;
  state: "running" | "complete" | "failed" | "cancelled";
  current: string;
  stage: string;
  progress: number | null;
  completed: AnalysisResult[];
  failed: { id: string; name: string; error: string }[];
  total: number;
};
declare global {
  interface Window {
    exmoDesktop: {
      status(analysis: Analysis): Promise<Reply<ModelStatus>>;
      list(analysis: Analysis): Promise<Reply<ImagingFile[]>>;
      results(analysis: Analysis): Promise<Reply<AnalysisResult[]>>;
      chooseFiles(analysis: Analysis, folder?: boolean): Promise<Reply<ImagingFile[]>>;
      preview(analysis: Analysis, id: string, options?: PreviewOptions): Promise<Reply<Preview>>;
      resultPreview(id: string, options?: PreviewOptions): Promise<Reply<Preview>>;
      run(
        analysis: Analysis,
        ids: string[],
        confirmedIds: string[],
        device: string,
      ): Promise<Reply<Job>>;
      job(): Promise<Reply<Job | null>>;
      variant(id: string, variant: string): Promise<Reply<AnalysisResult>>;
      cancel(analysis: Analysis): Promise<Reply<void>>;
      clear(analysis: Analysis): Promise<Reply<void>>;
    };
  }
}
export function unwrap<T>(reply: Reply<T>): T {
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
export const number = (value: number | null | undefined, digits = 1) =>
  value == null
    ? "—"
    : value.toLocaleString("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });
