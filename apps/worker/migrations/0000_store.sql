CREATE TABLE `judge_run` (
	`id` integer PRIMARY KEY NOT NULL,
	`set_id` text NOT NULL,
	`version` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`model` text NOT NULL,
	`model_version` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `judge_run_key` ON `judge_run` (`set_id`,`version`,`prompt_hash`,`model`);--> statement-breakpoint
CREATE INDEX `judge_run_set_id` ON `judge_run` (`set_id`);--> statement-breakpoint
CREATE TABLE `judgment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`question_id` text NOT NULL,
	`kind` text NOT NULL,
	`choice` text NOT NULL,
	`confidence` real NOT NULL,
	`probabilities` text NOT NULL,
	`reviewed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `judge_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `judgment_run_id` ON `judgment` (`run_id`);--> statement-breakpoint
CREATE TABLE `label` (
	`set_id` text NOT NULL,
	`version` text NOT NULL,
	`raw` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`set_id`, `version`)
);
