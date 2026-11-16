import { createRef } from "react";
import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { PreviewChromeRow } from "./PreviewChromeRow";

function row(showNavigation: boolean) {
  return (
    <PreviewChromeRow
      url=""
      loading={false}
      canGoBack={false}
      canGoForward={false}
      refreshDisabled={false}
      showNavigation={showNavigation}
      urlInputRef={createRef<HTMLInputElement>()}
      onBack={() => {}}
      onForward={() => {}}
      onRefresh={() => {}}
      onSubmit={() => {}}
    />
  );
}

it("hides back, forward and reload until a page has loaded", async () => {
  await using empty = await render(row(false));
  for (const name of ["Back", "Forward", "Reload"]) {
    expect(empty.container.querySelector(`[aria-label="${name}"]`)).toBeNull();
  }
  expect(empty.container.querySelector("input")).not.toBeNull();
});

it("shows back, forward and reload once a page is loaded", async () => {
  await using loaded = await render(row(true));
  for (const name of ["Back", "Forward", "Reload"]) {
    expect(loaded.container.querySelector(`[aria-label="${name}"]`)).not.toBeNull();
  }
});
