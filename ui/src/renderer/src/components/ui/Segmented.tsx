import { Segmented as BaseSegmented, type SegmentedOption, type SegmentedProps } from '../Segmented'

export interface CountedSegmentedOption<T extends string = string> extends SegmentedOption<T> {
  count?: number
}

export interface CountedSegmentedProps<T extends string = string> extends Omit<SegmentedProps<T>, 'options'> {
  options: CountedSegmentedOption<T>[]
}

export function Segmented<T extends string = string>({ options, leadingLabel, ...props }: CountedSegmentedProps<T>): React.JSX.Element {
  return (
    <BaseSegmented
      {...props}
      leadingLabel={leadingLabel && <span className="flex-none px-[var(--space-2)] [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">{leadingLabel}</span>}
      options={options.map(({ count, ...option }) => count === undefined || count === 0
        ? option
        : { ...option, label: <span className="inline-flex items-baseline gap-[var(--space-1-5)]">{option.label}<span className="text-[var(--text-muted)]">{count}</span></span> })}
    />
  )
}
