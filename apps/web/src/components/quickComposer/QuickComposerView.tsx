import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@houston-app/contracts";
import { DEFAULT_COMPOSER_PLACEHOLDER } from "../../composerPlaceholder";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import { randomUUID } from "../../lib/utils";
import { useClientSettings } from "~/hooks/useSettings";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { isClipboardImagePaste, readHostClipboardImageFile } from "../chat/hostClipboardImage";
import { Button } from "../ui/button";
import {
  QuickComposerAlert,
  QuickComposerEditorFrame,
  QuickComposerFooter,
  QuickComposerHint,
  QuickComposerImageRemove,
  QuickComposerImageThumb,
  QuickComposerImageTile,
  QuickComposerLabel,
  QuickComposerPanel,
} from "../ui/quick-composer";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { quickComposerEnterSubmits, quickComposerHint } from "./quickComposerKeys";
import type {
  QuickComposerImage,
  QuickComposerProjectOption,
  QuickComposerSubmitResult,
} from "./quickComposer.logic";

export interface QuickComposerViewProps {
  readonly projects: ReadonlyArray<QuickComposerProjectOption>;
  readonly initialProjectKey: string | null;
  readonly onSubmit: (input: {
    readonly project: QuickComposerProjectOption;
    readonly prompt: string;
    readonly images: ReadonlyArray<QuickComposerImage>;
  }) => Promise<QuickComposerSubmitResult>;
  readonly onClose: () => void;
}

export function QuickComposerView({
  projects,
  initialProjectKey,
  onSubmit,
  onClose,
}: QuickComposerViewProps) {
  const [projectKey, setProjectKey] = useState(initialProjectKey ?? projects[0]?.key ?? "");
  const [prompt, setPrompt] = useState("");
  const sendShortcut = useClientSettings((settings) => settings.sendShortcut);
  const [cursor, setCursor] = useState(0);
  const [images, setImages] = useState<ReadonlyArray<QuickComposerImage>>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const selectedProjectKey = projects.some((candidate) => candidate.key === projectKey)
    ? projectKey
    : (projects[0]?.key ?? "");
  const project = projects.find((candidate) => candidate.key === selectedProjectKey) ?? null;
  const canSubmit =
    (prompt.trim().length > 0 || images.length > 0) && !submitting && project !== null;

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- focuses the shared editor's DOM node when the window opens
  useEffect(() => {
    editorRef.current?.focus();
  }, []);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps a window keydown listener in step with the mounted quick composer
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const addImages = async (files: ReadonlyArray<File>) => {
    const accepted: QuickComposerImage[] = [];
    const failures: string[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        failures.push(`${file.name} is not an image.`);
        continue;
      }
      const prepared = await prepareImageForAttachment(
        file,
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      ).catch(() => ({ ok: false, reason: "unreadable" }) as const);
      if (!prepared.ok) {
        failures.push(
          prepared.reason === "unreadable"
            ? `${file.name} could not be read as an image.`
            : `${file.name} is too large to attach.`,
        );
        continue;
      }
      accepted.push({
        id: randomUUID(),
        name: prepared.file.name || file.name || "image",
        mimeType: prepared.file.type,
        sizeBytes: prepared.file.size,
        previewUrl: URL.createObjectURL(prepared.file),
        file: prepared.file,
      });
    }
    if (accepted.length > 0) setImages((current) => [...current, ...accepted]);
    setError(failures[0] ?? null);
  };

  const removeImage = (id: string) => {
    setImages((current) => {
      const image = current.find((candidate) => candidate.id === id);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return current.filter((candidate) => candidate.id !== id);
    });
  };

  const submit = async () => {
    if (!canSubmit || project === null) return;
    setSubmitting(true);
    setError(null);
    const result = await onSubmit({
      project,
      prompt,
      images,
    }).catch((cause: unknown) => ({
      ok: false as const,
      message: cause instanceof Error ? cause.message : "Houston could not start the thread.",
    }));
    setSubmitting(false);
    if (result.ok) {
      onClose();
      return;
    }
    setError(result.message);
  };

  const onEditorPaste = (event: ReactClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length > 0) {
      event.preventDefault();
      void addImages(files);
      return;
    }
    if (!isClipboardImagePaste(event.clipboardData)) return;
    const readImage = window.hostBridge?.readClipboardImage;
    if (!readImage) return;
    event.preventDefault();
    void readHostClipboardImageFile(readImage)
      .then((file) => (file === null ? undefined : addImages([file])))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not read the clipboard image."),
      );
  };

  const onEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || !quickComposerEnterSubmits(event, sendShortcut, prompt)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void submit();
  };

  return (
    <QuickComposerPanel
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer.files);
        if (files.length === 0) return;
        event.preventDefault();
        void addImages(files.filter((file) => file.type.startsWith("image/")));
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <QuickComposerLabel>New thread</QuickComposerLabel>
        <Button
          type="button"
          size="micro"
          variant="ghost"
          aria-label="Close quick composer"
          onClick={onClose}
        >
          Esc
        </Button>
      </div>

      <div className="flex gap-2">
        <Select
          value={selectedProjectKey}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            setProjectKey(value);
          }}
        >
          <SelectTrigger size="compact" className="min-w-0 flex-1" aria-label="Project">
            <SelectValue placeholder="Choose a project" />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} matchTriggerWidth>
            {projects.map((option) => (
              <SelectItem key={option.key} value={option.key} className="w-full">
                <span className="truncate">{option.title}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <QuickComposerEditorFrame onKeyDownCapture={onEditorKeyDown}>
        <ComposerPromptEditorTiptap
          ariaLabel="Thread prompt"
          editorRef={editorRef}
          value={prompt}
          cursor={cursor}
          contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
          skills={[]}
          disabled={submitting}
          placeholder={DEFAULT_COMPOSER_PLACEHOLDER}
          onChange={(nextValue, nextCursor) => {
            setPrompt(nextValue);
            setCursor(nextCursor);
          }}
          onPaste={onEditorPaste}
        />
        {images.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((image) => (
              <QuickComposerImageTile key={image.id}>
                <QuickComposerImageThumb src={image.previewUrl} alt={image.name} />
                <QuickComposerImageRemove
                  aria-label={`Remove ${image.name}`}
                  onClick={() => removeImage(image.id)}
                >
                  ×
                </QuickComposerImageRemove>
              </QuickComposerImageTile>
            ))}
          </div>
        ) : null}
      </QuickComposerEditorFrame>

      {error !== null ? <QuickComposerAlert>{error}</QuickComposerAlert> : null}

      <QuickComposerFooter>
        <QuickComposerHint>{quickComposerHint(sendShortcut)}</QuickComposerHint>
        <Button type="button" size="sm" disabled={!canSubmit} onClick={() => void submit()}>
          {submitting ? "Starting…" : "Start thread"}
        </Button>
      </QuickComposerFooter>
    </QuickComposerPanel>
  );
}
