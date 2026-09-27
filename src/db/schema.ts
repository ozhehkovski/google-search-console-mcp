/**
 * ClickHouse schema. Search Console rows are stored at the finest grain the API returns
 * (date × query × page × country × device), so every analysis can be computed locally.
 * Unlike Search Console itself, data is kept forever: history grows beyond 16 months.
 */
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS gsc_raw (
    site        LowCardinality(String),
    gsc_date    Date,
    kw_id       UInt64,
    page        String,
    country     LowCardinality(String),
    device      LowCardinality(String),
    clicks      UInt32,
    impressions UInt32,
    position    Float32
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(gsc_date)
  ORDER BY (site, gsc_date, kw_id, page)`,

  `CREATE TABLE IF NOT EXISTS dim_keyword (
    site  LowCardinality(String),
    kw_id UInt64,
    query String
  )
  ENGINE = ReplacingMergeTree
  ORDER BY (site, kw_id)`,

  `CREATE TABLE IF NOT EXISTS gsc_load_log (
    site      LowCardinality(String),
    load_date Date,
    row_count UInt32,
    loaded_at DateTime DEFAULT now()
  )
  ENGINE = ReplacingMergeTree(loaded_at)
  ORDER BY (site, load_date)`,

  `CREATE TABLE IF NOT EXISTS sites (
    site_url         String,
    permission_level LowCardinality(String),
    updated_at       DateTime DEFAULT now()
  )
  ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY site_url`,

  `CREATE TABLE IF NOT EXISTS site_settings (
    site        String,
    brand_names Array(String),
    updated_at  DateTime64(3) DEFAULT now64(3)
  )
  ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY site`,

  `CREATE TABLE IF NOT EXISTS annotations (
    id          UUID,
    site        String,
    event_date  Date,
    title       String,
    description String,
    created_at  DateTime DEFAULT now()
  )
  ENGINE = MergeTree
  ORDER BY (site, event_date, id)`,

  `CREATE TABLE IF NOT EXISTS url_inspections (
    site             LowCardinality(String),
    url              String,
    inspected_at     DateTime,
    verdict          LowCardinality(String),
    coverage_state   Nullable(String),
    indexing_state   Nullable(String),
    robots_txt_state Nullable(String),
    page_fetch_state Nullable(String),
    google_canonical Nullable(String),
    user_canonical   Nullable(String),
    last_crawl_time  Nullable(DateTime),
    clicks28d        UInt32,
    inspection_link  Nullable(String)
  )
  ENGINE = MergeTree
  ORDER BY (site, url, inspected_at)`,
];
