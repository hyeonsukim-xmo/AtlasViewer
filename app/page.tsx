import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Slider } from "../components/ui/slider";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import AnatomyScene from "./scene";
import Measurements from "./measurements";
import {
  GROUPS,
  INITIAL_STATE,
  STRUCTURES,
  inGroup,
  searchStructures,
  selectStructure,
  changeGroup,
  toggleStructureVisibility,
  visibleStructures,
  structureColor,
  type Group,
  type StructureId,
  type View,
} from "./anatomy";
import { registerAtlasTools } from "./agent-tools";

const VIEWS: { id: View; label: string }[] = [
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "side", label: "Side" },
  { id: "three-quarter", label: "3/4" },
];
const sliderValue = (value: number | readonly number[]) =>
  typeof value === "number" ? value : value[0];

export default function Home() {
  const [state, setState] = useState(INITIAL_STATE);
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState(() => !matchMedia("(max-width: 800px)").matches);
  const [about, setAbout] = useState(false);
  const [panel, setPanel] = useState<"structures" | "measurements">("structures");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const libraryToggle = useRef<HTMLButtonElement>(null);
  const aboutTitle = useRef<HTMLHeadingElement>(null);
  const selected = STRUCTURES.filter((s) => state.selected.includes(s.id));
  const visible = visibleStructures(state);
  const results = searchStructures(query).filter((s) => query.trim() || inGroup(s, state.group));
  const ready = progress === 100 && !error;

  const choose = useCallback(
    (id: StructureId | null, toggle = true) => {
      setState((s) =>
        id ? selectStructure(s, id, toggle) : { ...s, selected: [], isolate: false },
      );
      if (id && (state.explode || !toggle) && matchMedia("(max-width: 800px)").matches) {
        setLibrary(false);
        libraryToggle.current?.focus();
      }
    },
    [state.explode],
  );
  const stopRotation = useCallback(
    () => setState((s) => (s.rotate ? { ...s, rotate: false } : s)),
    [],
  );
  useEffect(() => registerAtlasTools((id) => choose(id, false)), [choose]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches('input,textarea,select,[contenteditable="true"]') || about) return;
      if (event.key === "/") {
        event.preventDefault();
        setLibrary(true);
        requestAnimationFrame(() => search.current?.focus());
      }
      if (event.key === "Escape") choose(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [choose, about]);

  function groupChanged(group: Group) {
    setState((s) => changeGroup(s, group));
    setQuery("");
  }
  function hide(id: StructureId) {
    setState((s) => toggleStructureVisibility(s, id));
  }
  function reset() {
    setState((s) => ({ ...INITIAL_STATE, reset: s.reset + 1 }));
    setQuery("");
  }

  return (
    <div className="studio dark">
      <header className="topbar">
        <a
          className="brand"
          href={import.meta.env.BASE_URL}
          aria-label="EXMO Segmentation Atlas home"
        >
          <img
            className="brand-logo"
            src={import.meta.env.BASE_URL + "brand/exmo-logo-white.svg"}
            alt="EXMO"
            width={951}
            height={169.28}
          />
          <span className="brand-caption">Segmentation Atlas</span>
        </a>
        <div className="case-tag">
          <span>
            Case <strong>1001921</strong>
          </span>
          <span className="case-divider" />
          <span>27 structures</span>
        </div>
        <nav className="header-actions" aria-label="Atlas panels">
          <Button
            variant="ghost"
            size="sm"
            aria-label="About this atlas"
            onClick={() => setAbout(true)}
          >
            About
          </Button>
          <Button
            ref={libraryToggle}
            variant="outline"
            className="library-toggle"
            aria-expanded={library}
            aria-controls="structure-library"
            onClick={() => setLibrary((open) => !open)}
          >
            <span>Structures</span>
          </Button>
        </nav>
      </header>

      <main className={"workspace" + (library ? " library-open" : "")}>
        <section className="viewer" aria-label="3D anatomy workspace">
          <div className="viewer-heading">
            <div className="viewer-title">
              <h1>{state.isolate ? "Selected structures" : state.group}</h1>
              <span className="view-mode">{state.explode ? "Exploded" : "Assembled"}</span>
            </div>
            <label className="color-preset">
              Colors
              <select
                aria-label="Color preset"
                value={state.colorPreset}
                onChange={(event) =>
                  setState((s) => ({
                    ...s,
                    colorPreset: event.target.value === "anatomical" ? "anatomical" : "class",
                  }))
                }
              >
                <option value="class">Class</option>
                <option value="anatomical">Muscle</option>
              </select>
            </label>
          </div>
          <div className="canvas-stage" aria-busy={!ready && !error}>
            <AnatomyScene
              key={attempt}
              state={state}
              onSelect={choose}
              onProgress={setProgress}
              onError={setError}
              onInteract={stopRotation}
            />

            {!error && !ready && (
              <div className="loading-card" role="status">
                <strong>Preparing the atlas</strong>
                <span>{progress}% · Loading 27 structures</span>
                <div className="loading-track">
                  <i style={{ width: progress + "%" }} />
                </div>
              </div>
            )}
            {error && (
              <div className="loading-card error-card" role="alert">
                <strong>Unable to display the model</strong>
                <span>{error}</span>
                <Button
                  onClick={() => {
                    setError("");
                    setProgress(0);
                    setAttempt((a) => a + 1);
                  }}
                >
                  Reload model
                </Button>
              </div>
            )}
            {ready && !visible.length && (
              <div className="loading-card">
                <strong>No structures visible</strong>
                <span>Show hidden structures to continue exploring.</span>
                <Button onClick={() => setState((s) => ({ ...s, hidden: [], isolate: false }))}>
                  Show structures
                </Button>
              </div>
            )}
            {ready && (
              <div className="orbit-hint">
                {state.explode >= 0.99 ? "Drag to pan" : "Drag to orbit"} <span>·</span> Scroll to
                zoom <span>·</span>{" "}
                {state.explode && selected.length
                  ? "Right-drag to rotate selection"
                  : state.explode
                    ? "Click to select"
                    : "Click to add / remove structures"}
              </div>
            )}
          </div>

          <div className="viewer-dock">
            <div className="dock-main">
              <div className="dock-views" role="group" aria-label="Camera views">
                {VIEWS.map((view) => (
                  <Button
                    key={view.id}
                    variant="ghost"
                    aria-pressed={state.view === view.id}
                    disabled={!ready || (state.explode >= 0.99 && view.id !== "front")}
                    onClick={() =>
                      setState((s) => ({ ...s, view: view.id, rotate: false, reset: s.reset + 1 }))
                    }
                  >
                    {view.label}
                  </Button>
                ))}
              </div>
              <div className="dock-actions">
                <Button
                  variant="ghost"
                  className="rotate-button"
                  aria-label={state.rotate ? "Pause rotation" : "Auto rotate"}
                  aria-pressed={state.rotate}
                  disabled={!ready || state.explode >= 0.99}
                  onClick={() => setState((s) => ({ ...s, rotate: !s.rotate }))}
                >
                  <span>{state.rotate ? "Pause" : "Rotate"}</span>
                </Button>
                <Button variant="ghost" aria-label="Reset atlas" onClick={reset}>
                  <span>Reset</span>
                </Button>
                <Button
                  className="dock-explode"
                  variant={state.explode ? "default" : "outline"}
                  aria-label={state.explode ? "Assemble anatomy" : "Explode anatomy"}
                  aria-pressed={state.explode === 1}
                  disabled={!ready || visible.length === 0}
                  onClick={() =>
                    setState((s) => ({
                      ...s,
                      explode: s.explode ? 0 : 1,
                      selected: s.explode
                        ? s.selected
                        : s.selected
                            .filter((id) =>
                              inGroup(
                                STRUCTURES.find((item) => item.id === id)!,
                                s.group,
                              ),
                            )
                            .slice(-1),
                      isolate: false,
                      view: "front",
                      rotate: false,
                    }))
                  }
                >
                  {state.explode ? "Assemble" : "Explode"}
                </Button>
              </div>
            </div>
            {selected.length > 0 && !state.isolate && (
              <div className="dock-opacity">
                <label id="opacity-label">Surrounding opacity</label>
                <Slider
                  aria-labelledby="opacity-label"
                  min={0}
                  max={100}
                  step={1}
                  value={[state.contextOpacity * 100]}
                  onValueChange={(value) =>
                    setState((s) => ({ ...s, contextOpacity: sliderValue(value) / 100 }))
                  }
                />
                <output>{Math.round(state.contextOpacity * 100)}%</output>
              </div>
            )}
          </div>
        </section>

        {library && (
          <aside className="library" id="structure-library" aria-label="Structure library">
            <div className="library-heading">
              <h2>
                Anatomy <span>27</span>
              </h2>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Close structure library"
                onClick={() => {
                  setLibrary(false);
                  libraryToggle.current?.focus();
                }}
              >
                Close
              </Button>
            </div>
            <div className="library-panels" role="group" aria-label="Library display">
              <Button
                variant="ghost"
                aria-pressed={panel === "structures"}
                onClick={() => setPanel("structures")}
              >
                Structures
              </Button>
              <Button
                variant="ghost"
                aria-pressed={panel === "measurements"}
                onClick={() => setPanel("measurements")}
              >
                Measurements <span>Demo</span>
              </Button>
            </div>
            <div className="search-box">
              <Input
                ref={search}
                aria-label="Search structures"
                placeholder="Search structures…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery("");
                    search.current?.focus();
                  }}
                >
                  Clear
                </Button>
              ) : (
                <kbd>/</kbd>
              )}
            </div>
            <div className="group-filters" role="group" aria-label="Anatomy groups">
              {GROUPS.map((group) => (
                <Button
                  key={group}
                  variant="ghost"
                  aria-pressed={state.group === group}
                  onClick={() => groupChanged(group)}
                >
                  {group}
                </Button>
              ))}
            </div>
            <div className="list-heading">
              <span>{query.trim() ? "Search results" : state.group}</span>
              <span>{results.length} structures</span>
            </div>
            <div
              className="structure-list"
              role="region"
              aria-label={panel === "measurements" ? "Demo measurements" : "Structures"}
            >
              {results.length ? (
                panel === "measurements" ? (
                  <Measurements
                    structures={results}
                    selected={state.selected}
                    colorPreset={state.colorPreset}
                    onSelect={choose}
                  />
                ) : (
                  results.map((structure) => {
                    const hidden = !visible.some((s) => s.id === structure.id);
                    const reason = state.hidden.includes(structure.id)
                      ? "Hidden"
                      : state.isolate
                        ? "Outside isolation"
                        : "Outside group";
                    return (
                      <div
                        className={
                          "structure-row" +
                          (state.selected.includes(structure.id) ? " selected" : "") +
                          (hidden ? " is-hidden" : "")
                        }
                        key={structure.id}
                      >
                        <Button
                          variant="ghost"
                          className="structure-choice"
                          aria-label={"Select " + structure.name}
                          aria-pressed={state.selected.includes(structure.id)}
                          onClick={() => choose(structure.id)}
                        >
                          <span
                            className="structure-dot"
                            style={{ background: structureColor(structure, state.colorPreset) }}
                          />
                          <span className="structure-text">
                            <strong>{structure.name}</strong>
                            <span>
                              {structure.group}
                              {hidden ? " · " + reason : ""}
                            </span>
                          </span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="visibility-button"
                          aria-label={(hidden ? "Show " : "Hide ") + structure.name}
                          aria-pressed={!hidden}
                          onClick={() => hide(structure.id)}
                        >
                          {hidden ? "Show" : "Hide"}
                        </Button>
                      </div>
                    );
                  })
                )
              ) : (
                <div className="empty-search">
                  <strong>No matching structures</strong>
                  <p>Try a name like “femur” or a group like “pelvic”.</p>
                  <Button variant="outline" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                </div>
              )}
            </div>
            <div className="library-footer">
              {selected.length > 0 && (
                <div className="library-selection" aria-live="polite">
                  <div className="selection-name">
                    <span>
                      {selected.length === 1
                        ? selected[0].group + " · Selected"
                        : "Selected together"}
                    </span>
                    <strong title={selected.map((s) => s.name).join(", ")}>
                      {selected.length === 1 ? selected[0].name : `${selected.length} structures`}
                    </strong>
                  </div>
                  <div className="selection-actions">
                    <Button
                      variant={state.isolate ? "default" : "outline"}
                      aria-pressed={state.isolate}
                      onClick={() =>
                        setState((s) => ({ ...s, isolate: !s.isolate, explode: 0, rotate: false }))
                      }
                    >
                      <span>{state.isolate ? "Show all" : "Isolate"}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Clear selection"
                      onClick={() => choose(null)}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
              )}

              <div className="visibility-summary">
                <span>
                  {visible.length} visible
                  {state.hidden.length ? " · " + state.hidden.length + " hidden" : ""}
                </span>
                {state.hidden.length > 0 ? (
                  <Button variant="ghost" onClick={() => setState((s) => ({ ...s, hidden: [] }))}>
                    Show hidden
                  </Button>
                ) : (
                  <span>27 source classes</span>
                )}
              </div>
            </div>
          </aside>
        )}
      </main>

      <Dialog open={about} onOpenChange={setAbout}>
        <DialogContent className="about-dialog" initialFocus={aboutTitle}>
          <Button variant="ghost" className="about-close" onClick={() => setAbout(false)}>
            Close
          </Button>
          <div className="eyebrow">EXMO Segmentation Atlas</div>
          <DialogTitle ref={aboutTitle} tabIndex={-1}>
            About this atlas
          </DialogTitle>
          <DialogDescription>
            An interactive viewer for the 27 segmentation classes supplied in EXMO case 1001921.
          </DialogDescription>
          <div className="about-content">
            <h3>Explore</h3>
            <p>
              In the assembled view, click structures to add or remove them from your selection.
              Selected structures stay visible when you switch group filters: choose bones in Bone,
              then add muscles from Posterior. Use Isolate to view your selection together. Drag to
              orbit the whole model; right-drag or use two fingers to pan. Scroll or pinch to zoom.
            </p>
            <p>
              Use Explode anatomy to separate visible classes over 1.7 seconds, and Assemble anatomy
              to bring them back together. The separated view stays in front so structures do not
              overlap. Select one structure and right-drag to rotate it around its own center. Click
              it again, click the background, or select another structure to return its orientation
              over 0.7 seconds. Assemble and Reset also restore its orientation.
            </p>
            <h3>Keyboard</h3>
            <p>
              <kbd>/</kbd> Search <span>·</span> <kbd>Esc</kbd> Clear selection
              <br />
              Focus the model: arrow keys orbit, <kbd>+</kbd> / <kbd>−</kbd> zoom.
              <br />
              In the exploded view, <kbd>Shift</kbd> + arrow keys rotate the selected structure.
            </p>
            <h3>Source & scope</h3>
            <p>
              27 original meshes · 424,456 triangles. Geometry, class names and colors come from the
              supplied EXMO HTML. A class may contain both sides of the body. Lower Body shows 24
              classes; All includes the 3 Trunk classes.
            </p>
            <p>
              The Measurements panel contains fictional left/right volume (cm³) and fat infiltration
              (%) samples, not measurements of this case. Hovering a paired structure identifies its
              patient side and emphasizes that side's sample values. In Front view, the patient's
              left is on screen right. Choose Class or Muscle colors above the model to change its
              appearance; these colors do not encode measurement values.
            </p>
            <a href={import.meta.env.BASE_URL + "ATTRIBUTION.md"} target="_blank" rel="noreferrer">
              Source and application credits
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
