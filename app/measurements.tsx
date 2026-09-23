import { Button } from "../components/ui/button";
import { structureColor, type ColorPreset, type Structure, type StructureId } from "./anatomy";
import { DEMO_MEASUREMENTS, volumeDifferencePercent } from "./demo-measurements";
import type { Side } from "./model-side";

const number = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const format = (value: number | null) => (value === null ? "—" : number.format(value));

export function MeasurementTable({
  structure,
  primarySide,
}: {
  structure: Structure;
  primarySide?: Side | null;
}) {
  const sample = DEMO_MEASUREMENTS[structure.id];
  const volume = sample?.volumeCm3;
  const fat = sample?.fatInfiltrationPercent;
  const first = primarySide === "right" ? 1 : 0;
  const second = first === 0 ? 1 : 0;
  if (!volume) return <p className="measurement-unavailable">Bilateral sample not provided.</p>;
  return (
    <table
      className={primarySide ? "side-comparison" : undefined}
      aria-label={structure.name + " demo measurements"}
    >
      <thead>
        <tr>
          <th scope="col">Demo</th>
          <th scope="col">
            {first === 0 ? "Left" : "Right"}
            {primarySide && <span>Hovered</span>}
          </th>
          <th scope="col">
            {second === 0 ? "Left" : "Right"}
            {primarySide && <span>Opposite</span>}
          </th>
          <th scope="col">Diff.</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">
            Volume <small>cm³</small>
          </th>
          <td>{format(volume[first])}</td>
          <td>{format(volume[second])}</td>
          <td>
            {format(volumeDifferencePercent(...volume))}
            <small>%</small>
          </td>
        </tr>
        {structure.group !== "Bone" && (
          <tr>
            <th scope="row">
              Fat infil. <small>%</small>
            </th>
            <td>{format(fat?.[first] ?? null)}</td>
            <td>{format(fat?.[second] ?? null)}</td>
            <td>
              {fat ? (
                <>
                  {format(Math.abs(fat[0] - fat[1]))}
                  <small>pp</small>
                </>
              ) : (
                "—"
              )}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default function Measurements({
  structures,
  selected,
  colorPreset,
  onSelect,
}: {
  structures: Structure[];
  selected: StructureId[];
  colorPreset: ColorPreset;
  onSelect: (id: StructureId) => void;
}) {
  return (
    <>
      <div className="measurement-notice">
        <strong>Demo data</strong>
        <p>Fictional values for preview. Not measurements of case 1001921.</p>
        <details>
          <summary>Comparison details</summary>
          <p>
            Volume difference = |L − R| ÷ mean(L, R) × 100. Fat infiltration difference is in
            percentage points (pp). Left / Right use patient orientation. All values are fictional.
          </p>
        </details>
      </div>
      {structures.map((structure) => {
        return (
          <article
            className={"measurement-card" + (selected.includes(structure.id) ? " selected" : "")}
            key={structure.id}
          >
            <Button
              variant="ghost"
              className="measurement-name"
              aria-label={"Select " + structure.name}
              aria-pressed={selected.includes(structure.id)}
              onClick={() => onSelect(structure.id)}
            >
              <span
                className="structure-dot"
                style={{ background: structureColor(structure, colorPreset) }}
              />
              {structure.name}
            </Button>
            <MeasurementTable structure={structure} />
          </article>
        );
      })}
    </>
  );
}
