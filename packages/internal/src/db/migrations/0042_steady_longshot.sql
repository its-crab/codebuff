CREATE TYPE "public"."memory_event_type" AS ENUM('hydrate', 'upsert_frame');

CREATE TABLE "memory_thread" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "fingerprint_id" text NOT NULL,
  "latest_revision" integer DEFAULT 0 NOT NULL,
  "frame_hash" text,
  "frame_text" text DEFAULT '' NOT NULL,
  "pinned_fact_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "unresolved_conflict_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "memory_thread_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
    ON DELETE cascade ON UPDATE no action
);

CREATE TABLE "memory_event" (
  "id" text PRIMARY KEY NOT NULL,
  "thread_id" text NOT NULL,
  "user_id" text NOT NULL,
  "event_type" "memory_event_type" NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "memory_event_thread_id_memory_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."memory_thread"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "memory_event_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
    ON DELETE cascade ON UPDATE no action
);

CREATE INDEX "idx_memory_thread_user" ON "memory_thread" USING btree ("user_id", "updated_at");
CREATE INDEX "idx_memory_thread_fingerprint" ON "memory_thread" USING btree ("user_id", "fingerprint_id", "updated_at");
CREATE INDEX "idx_memory_event_thread" ON "memory_event" USING btree ("thread_id", "created_at");
CREATE INDEX "idx_memory_event_user" ON "memory_event" USING btree ("user_id", "created_at");
