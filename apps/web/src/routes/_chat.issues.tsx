import { createFileRoute } from "@tanstack/react-router";

import { IssuesPage } from "../components/issue/IssuesPage";
import { validateIssuesSearch } from "../components/issue/issuesSearch";

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: validateIssuesSearch,
  component: IssuesPage,
});
