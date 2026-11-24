const SPARSE_HISTORY_MIN_HOURS = 1;

export function shouldUseSparseHistorySampling(queryHours) {
  return queryHours > SPARSE_HISTORY_MIN_HOURS;
}

function buildSampleJsonExpression(tableName, jsonColumns, sampleOrder, scoped, excluded, includeSource) {
  return `(
    SELECT json_object(${jsonColumns}${includeSource ? `, 'history_source', '${tableName}'` : ''})
    FROM ${tableName}
    WHERE id >= ranges.start_id
      AND id < ranges.end_id
      ${scoped ? 'AND server_id = (SELECT id FROM requested_server)' : ''}
      ${excluded ? 'AND NOT EXISTS(SELECT 1 FROM blocked_ranges WHERE timestamp >= blocked_ranges.start_ts AND timestamp < blocked_ranges.end_ts)' : ''}
    ORDER BY id ${sampleOrder}
    LIMIT 1
  )`;
}

export function buildSparseHistoryQuery({
  columns,
  queryStart,
  queryEnd,
  firstRangeEnd,
  intervalMs,
  idPrefix,
  oldTableExists,
  tableBoundary,
  sampleOrder = 'ASC',
  serverId = null,
  excludedRanges = [],
  includeSource = false
}) {
  const columnList = columns.split(',').map(column => column.trim()).filter(Boolean);
  const jsonColumns = ['timestamp', ...columnList]
    .flatMap(column => [`'${column}'`, column])
    .join(', ');
  const normalizedSampleOrder = String(sampleOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const bindValues = [
    queryStart,
    firstRangeEnd,
    intervalMs,
    queryEnd,
    queryEnd,
    idPrefix,
    idPrefix
  ];
  const scoped = serverId !== null;
  if (scoped) bindValues.push(serverId);
  const excluded = excludedRanges.length > 0;
  if (excluded) bindValues.push(JSON.stringify(excludedRanges));
  const currentSample = buildSampleJsonExpression('metrics_history', jsonColumns, normalizedSampleOrder, scoped, excluded, includeSource);
  let sampleExpression = currentSample;

  if (oldTableExists) {
    const oldSample = buildSampleJsonExpression('metrics_history_old', jsonColumns, normalizedSampleOrder, scoped, excluded, includeSource);
    sampleExpression = `COALESCE(
        CASE WHEN ranges.range_start < ? THEN ${oldSample} END,
        CASE WHEN ranges.range_end > ? THEN ${currentSample} END
      )`;
    bindValues.push(tableBoundary, tableBoundary);
  }

  return {
    sql: `
      WITH RECURSIVE sample_ranges(range_start, range_end) AS (
        SELECT ?, ?
        UNION ALL
        SELECT
          range_end,
          MIN(range_end + ?, ?)
        FROM sample_ranges
        WHERE range_end < ?
      ),
      id_ranges AS (
        SELECT
          range_start,
          range_end,
          ? + CAST(
            substr(
              strftime(
                '%Y%m%d%H%M%S',
                CAST(range_start / 1000 AS INTEGER),
                'unixepoch'
              ),
              3
            ) AS INTEGER
          ) AS start_id,
          ? + CAST(
            substr(
              strftime(
                '%Y%m%d%H%M%S',
                CAST(range_end / 1000 AS INTEGER),
                'unixepoch'
              ),
              3
            ) AS INTEGER
          ) AS end_id
        FROM sample_ranges
      )${scoped ? ', requested_server(id) AS (VALUES (?))' : ''}${excluded ? ', blocked_ranges(start_ts,end_ts) AS (SELECT value->>0,value->>1 FROM json_each(?))' : ''}
      SELECT ${sampleExpression} AS sample_json
      FROM id_ranges AS ranges
      ORDER BY ranges.range_start ASC
    `,
    bindValues
  };
}
