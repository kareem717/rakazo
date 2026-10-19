import { describe, expect, it } from "vitest";
import {
  groupBotsForSidebar,
  nestRosterByParent,
  reorderBotTo,
  sectionDestinations,
  sectionTree,
} from "./bot-sections.js";

const sections = [
  { id: "work", name: "Work" },
  { id: "home", name: "Home" },
];

describe("groupBotsForSidebar", () => {
  it("keeps pinned bots in one top-level group without duplicating them", () => {
    const groups = groupBotsForSidebar(
      [
        { id: "pinned", pinned: true, sectionId: "home" },
        { id: "work", pinned: false, sectionId: "work" },
        { id: "home", pinned: false, sectionId: "home" },
        { id: "loose", pinned: false, sectionId: null },
      ],
      sections,
    );

    expect(groups.map((group) => [group.title, group.bots.map((bot) => bot.id)])).toEqual([
      ["Pinned", ["pinned"]],
      ["Work", ["work"]],
      ["Home", ["home"]],
      ["Unassigned", ["loose"]],
    ]);
  });

  it("treats bots pointing at an unavailable section as unassigned", () => {
    const groups = groupBotsForSidebar(
      [{ id: "orphan", pinned: false, sectionId: "missing" }],
      sections,
    );
    expect(groups).toEqual([
      {
        key: "unassigned",
        title: "Unassigned",
        bots: [{ id: "orphan", pinned: false, sectionId: "missing" }],
      },
    ]);
  });

  it("does not add a heading before sections or pins exist", () => {
    const groups = groupBotsForSidebar([{ id: "first", pinned: false, sectionId: null }], []);
    expect(groups[0]?.title).toBeNull();
  });
});

describe("reorderBotTo", () => {
  const bots = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("moves a bot to the target bot's position in either direction", () => {
    expect(reorderBotTo(bots, "a", "c").map((bot) => bot.id)).toEqual(["b", "c", "a"]);
    expect(reorderBotTo(bots, "c", "a").map((bot) => bot.id)).toEqual(["c", "a", "b"]);
  });

  it("leaves the list alone when either bot is missing or unchanged", () => {
    expect(reorderBotTo(bots, "a", "missing")).toBe(bots);
    expect(reorderBotTo(bots, "a", "a")).toBe(bots);
  });
});

describe("nestRosterByParent", () => {
  it("nests children under parents that appear in the same list", () => {
    const rows = nestRosterByParent([
      { id: "chief", parentBotId: null },
      { id: "lead", parentBotId: "chief" },
      { id: "helper", parentBotId: "lead" },
      { id: "peer", parentBotId: null },
    ]);
    expect(rows.map((row) => [row.item.id, row.depth, row.hasChildren])).toEqual([
      ["chief", 0, true],
      ["lead", 1, true],
      ["helper", 2, false],
      ["peer", 0, false],
    ]);
    expect(rows.map((row) => row.parentId)).toEqual([null, "chief", "lead", null]);
  });

  it("keeps orphans as roots when the parent is not in the list", () => {
    const rows = nestRosterByParent([{ id: "helper", parentBotId: "missing" }]);
    expect(rows).toEqual([
      {
        item: { id: "helper", parentBotId: "missing" },
        depth: 0,
        hasChildren: false,
        parentId: null,
      },
    ]);
  });

  it("hides all descendants when a parent is collapsed", () => {
    const rows = nestRosterByParent(
      [
        { id: "chief", parentBotId: null },
        { id: "lead", parentBotId: "chief" },
        { id: "helper", parentBotId: "lead" },
      ],
      new Set(["chief"]),
    );
    expect(rows.map((row) => row.item.id)).toEqual(["chief"]);
    expect(rows[0]?.hasChildren).toBe(true);
  });

  it("preserves sibling order from the source list", () => {
    const rows = nestRosterByParent([
      { id: "chief", parentBotId: null },
      { id: "beta", parentBotId: "chief" },
      { id: "alpha", parentBotId: "chief" },
    ]);
    expect(rows.map((row) => row.item.id)).toEqual(["chief", "beta", "alpha"]);
  });

  it("breaks parent cycles without dropping the items", () => {
    const rows = nestRosterByParent([
      { id: "a", parentBotId: "b" },
      { id: "b", parentBotId: "a" },
    ]);
    expect(rows.map((row) => row.item.id).sort()).toEqual(["a", "b"]);
  });
});

describe("nested sections", () => {
  const tree = [
    { id: "child", name: "Inbox", parentId: "root" },
    { id: "other", name: "Other" },
    { id: "root", name: "Work" },
    { id: "leaf", name: "Replies", parentId: "child" },
  ];
  it("orders children after their parent even when the source is out of order", () => {
    expect(sectionTree(tree).map((item) => [item.id, item.depth, item.path])).toEqual([
      ["other", 0, "Other"],
      ["root", 0, "Work"],
      ["child", 1, "Work / Inbox"],
      ["leaf", 2, "Work / Inbox / Replies"],
    ]);
  });
  it("retains empty ancestors of populated subsections without duplicating chats", () => {
    const groups = groupBotsForSidebar([{ pinned: false, sectionId: "leaf" }], tree);
    expect(groups.map((item) => item.key)).toEqual([
      "section:root",
      "section:child",
      "section:leaf",
    ]);
    expect(groups.map((item) => item.bots.length)).toEqual([0, 0, 1]);
    expect(groups[2]).toMatchObject({ depth: 2, ancestorIds: ["root", "child"] });
  });
  it("excludes an entire subtree from move destinations", () => {
    expect(sectionDestinations(tree, "root").map((item) => item.id)).toEqual(["other"]);
    expect(sectionDestinations(tree, "child").map((item) => item.id)).toEqual(["other", "root"]);
  });
  it("surfaces stale or cyclic cached sections once each", () => {
    const rows = sectionTree([
      { id: "a", name: "A", parentId: "b" },
      { id: "b", name: "B", parentId: "a" },
      { id: "c", name: "C", parentId: "gone" },
    ]);
    expect(rows.map((item) => item.id).sort()).toEqual(["a", "b", "c"]);
  });
});
