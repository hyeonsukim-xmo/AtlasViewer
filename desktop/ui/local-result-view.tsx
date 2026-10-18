import type {ComponentProps} from 'react';
import ResultView from './result-view';
import Publication from './publication';
import ImagePreview from './image-preview';
import {unwrap} from './imaging';

// Keep Desktop operations outside the shared read-only presentation tree.
export default function LocalResultView(props: Omit<ComponentProps<typeof ResultView>, 'remote'|'local'>) {
  return <ResultView {...props} local={{
    publication: <Publication results={props.results}/>,
    preview: (result, classIds) => <ImagePreview key={result.id}
      revision={`${result.variant}:${result.laterality?.method || 'legacy'}`} analysis={result.analysis}
      id={result.id} result analysisRevision={result.analysisRevision} classIds={classIds}/>,
    variant: async (id, variant) => unwrap(await window.exmoDesktop.variant(id, variant)),
    sceneFailure: (id, code, reference) => {void window.exmoDesktop.sceneFailure(id, code, reference).catch(()=>{});},
    imageMenu: async (image, filename, id, language) => {unwrap(await window.exmoDesktop.imageMenu({image,filename,source:{kind:'result',id},language}));},
  }}/>;
}
