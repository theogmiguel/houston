type VariantAxes = Record<string, Record<string, string>>
type VariantSelection<Axes extends VariantAxes> = {
  [Axis in keyof Axes]?: keyof Axes[Axis]
}

export function variants<Axes extends VariantAxes>(
  base: string,
  axes: Axes,
  defaults: VariantSelection<Axes>
): (props?: VariantSelection<Axes>) => string {
  return (props = {}) =>
    [base, ...Object.keys(axes).map((axis) => {
      const key = props[axis] ?? defaults[axis]
      return axes[axis][key as string]
    })].filter(Boolean).join(' ')
}
