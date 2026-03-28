#!/usr/bin/env node
const path = require("path");
const { initializeDatabaseFile } = require("../lib/database");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = process.env.CODEX_MOBILE_DATA_DIR || path.join(ROOT_DIR, "data");
const DB_FILE = process.env.CODEX_MOBILE_DB_FILE || path.join(DATA_DIR, "codex-mobile.sqlite");
const LEGACY_STATE_FILE = process.env.CODEX_MOBILE_STATE_FILE || path.join(DATA_DIR, "state.json");
const DEFAULT_WORKSPACE_ROOT = process.env.CODEX_MOBILE_DEFAULT_WORKSPACE_ROOT || "/projects";

initializeDatabaseFile(DB_FILE, DEFAULT_WORKSPACE_ROOT, LEGACY_STATE_FILE).catch((error) => {
  console.error("Failed to initialize database:", error);
  process.exit(1);
});
