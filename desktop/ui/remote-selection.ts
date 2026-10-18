import type {RemoteSummary} from './imaging';

export const remoteViews = ['LAT_LT', 'AP', 'LAT_RT'] as const;
export const remoteView = (row: RemoteSummary) => row.route?.replaceAll('-', '_') || '';
export function remoteGroups(rows: RemoteSummary[]) {
  const groups = new Map<string, {key: string; study: boolean; items: RemoteSummary[]}>();
  for (const row of rows) {
    const study = row.analysis === 'xray' && !!row.context;
    const key = study ? JSON.stringify([row.context!.caseId, row.context!.studyId]) : row.resultId;
    if (!groups.has(key)) groups.set(key, {key, study, items: []});
    groups.get(key)!.items.push(row);
  }
  return [...groups.values()].map(group => ({...group, items: group.items.toSorted((a, b) => {
    const rank = (row: RemoteSummary) => {const i = remoteViews.indexOf(remoteView(row) as typeof remoteViews[number]); return i < 0 ? 3 : i;};
    return rank(a) - rank(b);
  })}));
}
// A duplicate view needs an explicit choice; neither date nor list order proves which result to use.
export function remoteStudy(rows: RemoteSummary[]) {
  const missing = remoteViews.filter(view => !rows.some(row => remoteView(row) === view));
  const ambiguous = rows.some(row => !remoteViews.includes(remoteView(row) as typeof remoteViews[number])) ||
    remoteViews.some(view => rows.filter(row => remoteView(row) === view).length > 1);
  return {missing, ambiguous, ids: ambiguous ? [] : remoteViews.flatMap(view => rows.filter(row => remoteView(row) === view).map(row => row.resultId))};
}
