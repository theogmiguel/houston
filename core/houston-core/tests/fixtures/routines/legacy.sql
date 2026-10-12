CREATE TABLE named_agents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                engine TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT '',
                about_you TEXT NOT NULL DEFAULT '',
                skills TEXT NOT NULL DEFAULT '[]',
                memory_budget INTEGER NOT NULL,
                reflection_mode TEXT NOT NULL DEFAULT 'off',
                allow_agent_scheduling INTEGER NOT NULL DEFAULT 0,
                disabled_plugin_ids TEXT NOT NULL DEFAULT '[]',
                schema_version INTEGER NOT NULL DEFAULT 1,
                revision INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                working_dir TEXT,
                purpose TEXT NOT NULL DEFAULT '',
                default_model TEXT,
                default_effort TEXT,
                default_permission_mode TEXT,
                default_plan INTEGER NOT NULL DEFAULT 0,
                allow_agent_messaging INTEGER NOT NULL DEFAULT 0,
                avatar TEXT,
                thread_id INTEGER,
                title TEXT NOT NULL DEFAULT '',
                notify INTEGER NOT NULL DEFAULT 1,
                retain_detail_days INTEGER NOT NULL DEFAULT 30
            );
            INSERT INTO named_agents
                (name, engine, memory_budget, working_dir, default_model, default_effort,
                 created_at, updated_at)
            VALUES ('Scout', 'codex', 2200, '/tmp/scout-dir', 'gpt-5.2', 'low', 0, 0);
            CREATE TABLE routines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                name_folded TEXT NOT NULL,
                prompt TEXT NOT NULL,
                cadence TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                author TEXT NOT NULL DEFAULT 'builder',
                workspace_id TEXT,
                next_run_at_ms INTEGER NOT NULL,
                last_run_at_ms INTEGER,
                last_run_session_id INTEGER,
                last_error TEXT,
                revision TEXT NOT NULL,
                permission_mode TEXT NOT NULL DEFAULT 'accept_edits',
                isolate INTEGER NOT NULL DEFAULT 0,
                last_outcome TEXT,
                continue_context INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO routines
                (agent_id, name, name_folded, prompt, cadence, enabled, author,
                 next_run_at_ms, last_error, last_outcome, revision, created_at, updated_at)
            VALUES (1, 'Legacy sweep', 'legacy sweep', 'run the sweep',
                    '{"type":"interval","seconds":900}', 1, 'agent', 0,
                    'conversation archive full', 'archive_full', 'rev-legacy', 0, 0);
            CREATE TABLE routine_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                routine_id INTEGER NOT NULL,
                trigger TEXT NOT NULL,
                status TEXT NOT NULL,
                session_id INTEGER,
                thread_id INTEGER,
                error TEXT,
                started_at_ms INTEGER NOT NULL,
                ended_at_ms INTEGER
            );
            INSERT INTO routine_runs
                (routine_id, trigger, status, thread_id, error, started_at_ms)
            VALUES (1, 'schedule', 'archive_full', 7, 'conversation archive full', 0);
            CREATE TABLE chat_threads (id INTEGER);
            CREATE TABLE chat_messages (id INTEGER);
            CREATE TABLE agent_messages (id INTEGER);
            CREATE TABLE agent_skill_sources (id INTEGER);
CREATE UNIQUE INDEX idx_routines_agent_name ON routines(agent_id, name_folded);
