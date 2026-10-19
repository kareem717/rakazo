import { groupBotsForSidebar, sectionTree } from "@rakazo/core";

type SidebarChat = {
  id: string;
  name: string;
  title?: string | null;
  preview?: string | null;
  pinned: boolean;
  sectionId: string | null;
  parentBotId?: string | null;
};

type SidebarSpace<TBot extends SidebarChat, TGroup extends SidebarChat> = {
  id: string;
  name: string;
  canRename?: boolean;
  canDelete?: boolean;
  bots: readonly TBot[];
  groups: readonly TGroup[];
  botSections: readonly { id: string; name: string; parentId?: string | null }[];
};

function spaceHeaderMenu(space: { canRename?: boolean; canDelete?: boolean }, hostsMenu: boolean) {
  return {
    canRenameSpace: hostsMenu && space.canRename === true,
    canDeleteSpace: hostsMenu && space.canDelete === true,
    // Every member can open a space's settings, so the menu does not depend on rename or delete.
    canOpenSpaceSettings: hostsMenu,
  };
}

export async function commitSpaceRename(input: {
  rename: () => Promise<void>;
  apply: () => void;
  refresh: () => Promise<void>;
}): Promise<void> {
  await input.rename();
  input.apply();
  await input.refresh().catch(() => undefined);
}

export function sidebarGroupsForSpaces<TBot extends SidebarChat, TGroup extends SidebarChat>(
  spaces: readonly SidebarSpace<TBot, TGroup>[],
  query: string,
) {
  const needle = query.toLowerCase();
  const showSpaceNames = spaces.length > 1;
  return spaces.flatMap((space) => {
    const visibleBots = space.bots.filter((bot) =>
      `${bot.name} ${bot.title ?? ""} ${bot.preview ?? ""}`.toLowerCase().includes(needle),
    );
    const visibleGroups = space.groups.filter((group) =>
      `${group.name} ${group.preview ?? ""}`.toLowerCase().includes(needle),
    );
    const grouped = groupBotsForSidebar(
      [
        ...visibleBots.map((chat) => ({ kind: "bot" as const, chat })),
        ...visibleGroups.map((chat) => ({ kind: "group" as const, chat })),
      ].map((item) => ({
        ...item,
        id: item.chat.id,
        parentBotId: item.kind === "bot" ? (item.chat.parentBotId ?? null) : null,
        pinned: item.chat.pinned,
        sectionId: item.chat.sectionId,
      })),
      space.botSections,
      { includeEmptySections: !needle && visibleBots.length + visibleGroups.length > 0 },
    );
    // Keep destinations visible after their last bot is dragged out. Search
    // still hides empty lists, and spaces without sections keep their old layout.
    if (!needle && space.botSections.length > 0 && grouped.length > 0) {
      if (!grouped.some((group) => group.key === "unassigned")) {
        grouped.push({ key: "unassigned", title: "Unassigned", bots: [] });
      }
      const order = [
        "pinned",
        ...sectionTree(space.botSections).map((section) => `section:${section.id}`),
        "unassigned",
      ];
      grouped.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    }
    const sections = grouped.map((group, index) => ({
      ...group,
      depth: group.depth ?? 0,
      ancestorKeys: (group.ancestorIds ?? []).map((id) =>
        showSpaceNames ? `space:${space.id}:section:${id}` : `section:${id}`,
      ),
      sectionId: group.key.startsWith("section:") ? group.key.slice("section:".length) : null,
      key: showSpaceNames ? `space:${space.id}:${group.key}` : group.key,
      title:
        showSpaceNames && !group.depth
          ? group.title
            ? `${space.name} · ${group.title}`
            : space.name
          : group.title,
      showLock: showSpaceNames && !group.depth,
      emptySpaceId: undefined as string | undefined,
      spaceId: space.id,
      spaceName: space.name,
      ...spaceHeaderMenu(space, index === 0),
    }));
    if (sections.length > 0) return sections;
    // Keep empty spaces selectable; chat clicks are the only switch control.
    if (needle && (space.bots.length > 0 || space.groups.length > 0)) return [];
    // Saved sections stay listed under the placeholder so they can still be
    // renamed or deleted after their last chat leaves.
    const emptySections = needle
      ? []
      : sectionTree(space.botSections).map((section) => ({
          depth: section.depth,
          ancestorKeys: section.ancestorIds.map((id) =>
            showSpaceNames ? `space:${space.id}:section:${id}` : `section:${id}`,
          ),
          key: showSpaceNames ? `space:${space.id}:section:${section.id}` : `section:${section.id}`,
          title:
            showSpaceNames && !section.depth ? `${space.name} · ${section.name}` : section.name,
          bots: [] as (typeof sections)[number]["bots"],
          sectionId: section.id as string | null,
          showLock: showSpaceNames && !section.depth,
          emptySpaceId: undefined as string | undefined,
          spaceId: space.id,
          spaceName: space.name,
          ...spaceHeaderMenu(space, false),
        }));
    // A lone space is the selected one, so its settings stay in the account menu too.
    const lone = !showSpaceNames && !space.canRename && !space.canDelete;
    if (lone && (needle || emptySections.length > 0)) {
      return emptySections;
    }
    return [
      {
        key: showSpaceNames ? `space:${space.id}:empty` : `space:${space.id}:actions`,
        title: showSpaceNames ? space.name : null,
        bots: [],
        depth: 0,
        ancestorKeys: [] as string[],
        sectionId: null,
        showLock: showSpaceNames,
        emptySpaceId: showSpaceNames ? space.id : undefined,
        spaceId: space.id,
        spaceName: space.name,
        ...spaceHeaderMenu(space, true),
      },
      ...emptySections,
    ];
  });
}
