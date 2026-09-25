CREATE TABLE `openfda_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`fetched_at_ms` integer NOT NULL
);
