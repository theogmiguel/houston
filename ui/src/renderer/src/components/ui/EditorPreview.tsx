import type { AudioHTMLAttributes, ImgHTMLAttributes, ReactNode, VideoHTMLAttributes } from 'react'
import { Text } from './Text'

export function PreviewState({ children, className = '', ...props }: React.HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 py-0 text-center ${className}`}>{children}</div>
}

export function PreviewStatus({ children, chat = false, ...props }: React.HTMLAttributes<HTMLDivElement> & { children: ReactNode; chat?: boolean }): React.JSX.Element {
  return <div {...props} className={`flex flex-col ${chat ? 'items-start text-left' : 'items-center text-center'} gap-1.5 ${props.className ?? ''}`}>{children}</div>
}

export function PreviewTitle({ children, as = 'span', ...props }: React.HTMLAttributes<HTMLElement> & { children: ReactNode; as?: 'span' | 'div' }): React.JSX.Element {
  return <Text {...props} as={as} size="ui" weight="medium" tone="primary" className={`max-w-[var(--w-editor-preview-copy)] ${props.className ?? ''}`}>{children}</Text>
}

export function PreviewName({ children, ...props }: React.HTMLAttributes<HTMLElement> & { children: ReactNode }): React.JSX.Element {
  return <Text {...props} as="span" size="small" weight="small" tone="muted" breakAll className={`max-w-[var(--w-editor-preview-copy)] ${props.className ?? ''}`}>{children}</Text>
}

export function PreviewDetail({ children, as = 'span', ...props }: React.HTMLAttributes<HTMLElement> & { children: ReactNode; as?: 'span' | 'div' }): React.JSX.Element {
  return <Text {...props} as={as} size="small" weight="small" tone="faint" leading="markdown" className={`max-w-[var(--w-editor-preview-copy)] ${props.className ?? ''}`}>{children}</Text>
}

export function MediaPreviewSurface({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`absolute inset-0 flex items-center justify-center overflow-auto p-6 ${props.className ?? ''}`}>{children}</div>
}

export function MediaPreviewImage(props: ImgHTMLAttributes<HTMLImageElement>): React.JSX.Element {
  return <img {...props} className={`max-h-full max-w-full object-contain ${props.className ?? ''}`} />
}

export function MediaPreviewVideo(props: VideoHTMLAttributes<HTMLVideoElement>): React.JSX.Element {
  return <video {...props} className={`max-h-full max-w-full ${props.className ?? ''}`} />
}

export function MediaPreviewAudio({ children, ...props }: AudioHTMLAttributes<HTMLAudioElement>): React.JSX.Element {
  return <audio {...props} className={`w-full ${props.className ?? ''}`}>{children}</audio>
}

export function MediaPreviewAudioGroup({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`flex w-full max-w-md flex-col items-center gap-3 ${props.className ?? ''}`}>{children}</div>
}

export function MarkdownPreviewViewport({ children, enabled = true, ...props }: React.HTMLAttributes<HTMLDivElement> & { children: ReactNode; enabled?: boolean }): React.JSX.Element {
  return <div {...props} className={`${enabled ? 'absolute inset-0 overflow-auto' : ''} ${props.className ?? ''}`}>{children}</div>
}

export function MarkdownPreviewPage({ children, enabled = true, ...props }: React.HTMLAttributes<HTMLDivElement> & { children: ReactNode; enabled?: boolean }): React.JSX.Element {
  return <div {...props} className={`${enabled ? 'mx-auto max-w-4xl px-8 py-6' : ''} ${props.className ?? ''}`}>{children}</div>
}
