// MUTATION FIXTURE: a bare text-size literal, which check-type-scale.sh must
// refuse. Never imported.
export const Bad = () => <span className="text-[13px] [font-size:9px]">x</span>
