# Tasks

Tasks are a local backlog, one list per workspace. Open the **Tasks** tab in the side
panel beside **Source control** and **Files**. The list is grouped by status with a count
per group: **In progress**, **In review**, **Todo**, **Backlog**, **Done** and **Canceled**.
Each row carries a priority glyph, the task key (`HOU-1`), its title and the time since it
last changed. The **Done** and **Canceled** groups start collapsed; click a group header to
fold or unfold it. **Archived** tasks sit in a final collapsed group.

## Creating and editing

Choose **New task** in the tab header, or the plus on a group header to create straight into
that status. A task has a title, a description, a status, a priority and an optional parent
task. The acceptance list holds the checks the work must satisfy. Open a task to edit any of
these; changes save when a field loses focus. Only one revision is saved at a time, so if the
task changed elsewhere first, a **This task changed elsewhere** banner appears with **Reload**
before you overwrite anything.

Tick an acceptance item to check it. Comments appear in the same chronological activity feed
as the recorded changes, with a composer below. The task menu in the detail header archives
the task; an archived task shows the same menu with **Restore task**.

## Agent access

Settings ▸ Tasks controls whether agents running in a workspace may read and write its
tasks. **Off** withholds them entirely, **Read only** lets them look but not change, and
**Read and write** allows both. The current value is shown on the settings row and in the
Tasks tab's menu, and a write that the setting refuses names the setting that has to change.
Changing access applies to the workspace selected in the sidebar.

## What leaves the machine

Tasks live in Houston's local database, per workspace. Houston sends no task text to any
service. A task's title, description and acceptance only reach a hosted agent CLI if an
agent you allowed reads it; access is per workspace and starts at **Read and write**.
