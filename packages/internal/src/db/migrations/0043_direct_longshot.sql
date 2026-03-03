ALTER TYPE "public"."memory_event_type" ADD VALUE IF NOT EXISTS 'upsert_facts';
ALTER TYPE "public"."memory_event_type" ADD VALUE IF NOT EXISTS 'query_facts';

CREATE TYPE "public"."memory_conflict_status" AS ENUM('unresolved', 'resolved');

CREATE TABLE "memory_fact" (
  "id" text PRIMARY KEY NOT NULL,
  "thread_id" text NOT NULL,
  "user_id" text NOT NULL,
  "fact_key" text NOT NULL,
  "fact_hash" text NOT NULL,
  "content" text NOT NULL,
  "confidence" integer DEFAULT 50 NOT NULL,
  "weight" integer DEFAULT 50 NOT NULL,
  "tags" text[] DEFAULT '{}'::text[] NOT NULL,
  "source_event_id" text,
  "active" boolean DEFAULT true NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "memory_fact_thread_id_memory_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."memory_thread"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "memory_fact_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "memory_fact_source_event_id_memory_event_id_fk"
    FOREIGN KEY ("source_event_id") REFERENCES "public"."memory_event"("id")
    ON DELETE set null ON UPDATE no action
);

CREATE TABLE "memory_conflict" (
  "id" text PRIMARY KEY NOT NULL,
  "thread_id" text NOT NULL,
  "user_id" text NOT NULL,
  "left_fact_id" text NOT NULL,
  "right_fact_id" text NOT NULL,
  "status" "memory_conflict_status" DEFAULT 'unresolved' NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "memory_conflict_thread_id_memory_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."memory_thread"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "memory_conflict_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "memory_conflict_left_fact_id_memory_fact_id_fk"
    FOREIGN KEY ("left_fact_id") REFERENCES "public"."memory_fact"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "memory_conflict_right_fact_id_memory_fact_id_fk"
    FOREIGN KEY ("right_fact_id") REFERENCES "public"."memory_fact"("id")
    ON DELETE cascade ON UPDATE no action
);

CREATE TABLE "memory_fact_edge" (
  "id" text PRIMARY KEY NOT NULL,
  "thread_id" text NOT NULL,
  "user_id" text NOT NULL,
  "from_fact_id" text NOT NULL,
  "to_fact_id" text NOT NULL,
  "relation" text NOT NULL,
  "weight" integer DEFAULT 50 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "memory_fact_edge_thread_id_memory_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."memory_thread"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "memory_fact_edge_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "memory_fact_edge_from_fact_id_memory_fact_id_fk"
    FOREIGN KEY ("from_fact_id") REFERENCES "public"."memory_fact"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "memory_fact_edge_to_fact_id_memory_fact_id_fk"
    FOREIGN KEY ("to_fact_id") REFERENCES "public"."memory_fact"("id")
    ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX "unique_memory_fact_hash_per_thread" ON "memory_fact" USING btree ("thread_id", "fact_hash");
CREATE INDEX "idx_memory_fact_thread_key" ON "memory_fact" USING btree ("thread_id", "fact_key", "updated_at");
CREATE INDEX "idx_memory_fact_thread_active" ON "memory_fact" USING btree ("thread_id", "active", "updated_at");
CREATE UNIQUE INDEX "unique_memory_conflict_pair" ON "memory_conflict" USING btree ("thread_id", "left_fact_id", "right_fact_id");
CREATE INDEX "idx_memory_conflict_thread_status" ON "memory_conflict" USING btree ("thread_id", "status", "created_at");
CREATE UNIQUE INDEX "unique_memory_fact_edge" ON "memory_fact_edge" USING btree ("thread_id", "from_fact_id", "to_fact_id", "relation");
CREATE INDEX "idx_memory_fact_edge_thread" ON "memory_fact_edge" USING btree ("thread_id", "created_at");
