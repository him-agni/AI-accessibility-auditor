import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const audits = sqliteTable("audits", {
  id: text("id").primaryKey(),
  submittedUrl: text("submitted_url").notNull(),
  finalUrl: text("final_url"),
  status: text("status", { enum: ["queued", "running", "generating", "completed", "failed"] }).notNull(),
  pageTitle: text("page_title"),
  viewport: text("viewport").notNull().default("1440x900"),
  axeVersion: text("axe_version"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  reportJson: text("report_json"),
  requestFingerprint: text("request_fingerprint").notNull(),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  index("idx_audits_request_created").on(table.requestFingerprint, table.createdAt),
  index("idx_audits_expires").on(table.expiresAt),
]);

export const issueGroups = sqliteTable("issue_groups", {
  id: text("id").primaryKey(),
  auditId: text("audit_id").notNull().references(() => audits.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull(),
  impact: text("impact").notNull(),
  description: text("description").notNull(),
  help: text("help").notNull(),
  helpUrl: text("help_url").notNull(),
  wcagTags: text("wcag_tags").notNull(),
  occurrenceCount: integer("occurrence_count").notNull(),
}, (table) => [index("idx_issue_groups_audit").on(table.auditId)]);

export const occurrences = sqliteTable("occurrences", {
  id: text("id").primaryKey(),
  issueGroupId: text("issue_group_id").notNull().references(() => issueGroups.id, { onDelete: "cascade" }),
  selector: text("selector").notNull(),
  htmlSnippet: text("html_snippet").notNull(),
  failureSummary: text("failure_summary").notNull(),
}, (table) => [index("idx_occurrences_group").on(table.issueGroupId)]);

export const fixSuggestions = sqliteTable("fix_suggestions", {
  id: text("id").primaryKey(),
  issueGroupId: text("issue_group_id").notNull().references(() => issueGroups.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  whyItMatters: text("why_it_matters").notNull(),
  stepsJson: text("steps_json").notNull(),
  codeExample: text("code_example"),
  confidence: text("confidence").notNull(),
  requiresManualReview: integer("requires_manual_review", { mode: "boolean" }).notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("idx_fix_suggestions_group").on(table.issueGroupId)]);
