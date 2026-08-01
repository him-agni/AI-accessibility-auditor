CREATE TABLE `audits` (
	`id` text PRIMARY KEY NOT NULL,
	`submitted_url` text NOT NULL,
	`final_url` text,
	`status` text NOT NULL,
	`page_title` text,
	`viewport` text DEFAULT '1440x900' NOT NULL,
	`axe_version` text,
	`error_code` text,
	`error_message` text,
	`report_json` text,
	`request_fingerprint` text NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audits_request_created` ON `audits` (`request_fingerprint`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audits_expires` ON `audits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `fix_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_group_id` text NOT NULL,
	`summary` text NOT NULL,
	`why_it_matters` text NOT NULL,
	`steps_json` text NOT NULL,
	`code_example` text,
	`confidence` text NOT NULL,
	`requires_manual_review` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_group_id`) REFERENCES `issue_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fix_suggestions_group` ON `fix_suggestions` (`issue_group_id`);--> statement-breakpoint
CREATE TABLE `issue_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`audit_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`impact` text NOT NULL,
	`description` text NOT NULL,
	`help` text NOT NULL,
	`help_url` text NOT NULL,
	`wcag_tags` text NOT NULL,
	`occurrence_count` integer NOT NULL,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_issue_groups_audit` ON `issue_groups` (`audit_id`);--> statement-breakpoint
CREATE TABLE `occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_group_id` text NOT NULL,
	`selector` text NOT NULL,
	`html_snippet` text NOT NULL,
	`failure_summary` text NOT NULL,
	FOREIGN KEY (`issue_group_id`) REFERENCES `issue_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_occurrences_group` ON `occurrences` (`issue_group_id`);