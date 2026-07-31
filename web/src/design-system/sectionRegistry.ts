export const DESIGN_SYSTEM_SECTIONS = [
  { id: "colors", label: "Colors", group: "Foundations" },
  { id: "typography", label: "Typography", group: "Foundations" },
  { id: "control-scale", label: "Control scale", group: "Foundations" },
  { id: "buttons", label: "Buttons", group: "Components" },
  { id: "feedback", label: "Dialog & toast", group: "Components" },
  { id: "job-actions", label: "Job actions", group: "Product patterns" },
  { id: "asset-toolbar", label: "Asset toolbar", group: "Product patterns" },
  { id: "boundaries", label: "System boundaries", group: "Governance" },
] as const;

export type DesignSystemSectionId = (typeof DESIGN_SYSTEM_SECTIONS)[number]["id"];
