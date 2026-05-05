// Group B live-DB sanity check
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "./src/db/migration.js";
import {
  tryLoadSqliteVec,
  vec0Version,
  registerEmbeddingProfile,
  ensureEmbeddingsTable,
  embeddingsTableExists,
  embeddingsTableName,
} from "./src/embeddings/store.js";
import { countPendingDocs } from "./src/embeddings/backfill.js";

const DB = "/Volumes/LEXAR/lcm-tmp/lcm-test-groupB-review.db";
const VEC0 = "/Users/lume/.openclaw/extensions/node_modules/sqlite-vec-darwin-arm64/vec0.dylib";

const db = new DatabaseSync(DB, { allowExtension: true });
console.log("[sanity] opened db");

const loaded = tryLoadSqliteVec(db, { path: VEC0 });
console.log("[sanity] vec0 loaded:", loaded, "version:", vec0Version(db));

// Need busy_timeout for migrations
db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA foreign_keys = ON");

const t0 = Date.now();
try {
  runLcmMigrations(db, { fts5Available: true, log: () => {} });
  console.log("[sanity] migrations ok in", Date.now() - t0, "ms");
} catch (e) {
  console.error("[sanity] migrations FAILED after", Date.now() - t0, "ms:", e.message);
  console.error(e);
  process.exit(1);
}

// Register profile + ensure table for voyage-4-large @ dim=1024
const MODEL = "voyage-4-large";
const DIM = 1024;
registerEmbeddingProfile(db, MODEL, DIM);
ensureEmbeddingsTable(db, MODEL, DIM);
console.log("[sanity] table created:", embeddingsTableName(MODEL), "exists:", embeddingsTableExists(db, MODEL));

// Triggers visible?
const triggers = db.prepare(
  `SELECT name, tbl_name FROM sqlite_master WHERE type='trigger'
     AND name IN (
       'lcm_embed_suppress_voyage4large',
       'lcm_embed_delete_voyage4large',
       'lcm_embedding_meta_cleanup_summary'
     ) ORDER BY name`,
).all();
console.log("[sanity] triggers:", triggers);

// countPendingDocs against real corpus
const t1 = Date.now();
const pending = countPendingDocs(db, { modelName: MODEL });
console.log("[sanity] pending leaves:", pending, "(took", Date.now() - t1, "ms)");

// Sanity: total leaf count, total summaries
const totalLeaves = db.prepare(
  `SELECT COUNT(*) AS n FROM summaries WHERE kind='leaf' AND suppressed_at IS NULL`,
).get();
const totalSummaries = db.prepare(`SELECT COUNT(*) AS n FROM summaries`).get();
const conv = db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get();
console.log("[sanity] totals: leaves(unsuppressed)=", totalLeaves.n, "all summaries=", totalSummaries.n, "convs=", conv.n);

// Verify embedded_kind metadata column behavior
const tableMeta = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get("lcm_embeddings_voyage4large");
console.log("[sanity] vec0 table SQL:", tableMeta?.sql ?? "(missing)");

// Quick sanity on placeholder count:
const checkSampleId = db.prepare(`SELECT summary_id FROM summaries WHERE kind='leaf' LIMIT 1`).get();
console.log("[sanity] sample leaf:", checkSampleId?.summary_id);

// Check session_key columns on summaries table for the change
const colInfo = db.prepare(`PRAGMA table_info(summaries)`).all().filter(c => c.name === "session_key");
console.log("[sanity] summaries.session_key column:", colInfo);

db.close();
console.log("[sanity] DONE");
