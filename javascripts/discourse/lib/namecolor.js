const APPLIED_CLASS = "discourse-namecolor-name";
const ENABLED_CLASS = "discourse-namecolor-enabled";
const BOLD_CLASS = "discourse-namecolor-bold";

const NAME_TARGET_SELECTOR = [
  ".topic-post .names .first",
  ".topic-post .names .second",
  ".post-list-item .post-member-info.names .name",
  ".user-card .names__primary",
  ".user-card .names__secondary",
  "a[data-user-card]",
  "a.mention",
].join(", ");

const PALETTE = [
  "#c94747",
  "#2f7d5b",
  "#2f6fbb",
  "#a24f89",
  "#b06818",
  "#0f7f86",
  "#6b62b7",
  "#bf3f68",
  "#5f7d26",
  "#a66f00",
];

const SAFE_COLOR_PATTERN =
  /^(#[0-9a-f]{3,8}|[a-z][a-z0-9-]*|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([a-z0-9\s.,%/+_-]+\)|var\(--[a-z0-9_-]+\))$/i;

const INVALID_GROUP_NAMES = new Set(["", "undefined", "null"]);

export function buildNameColorRules(themeSettings) {
  const userColors = new Map();
  const groupColors = new Map();

  rowsFor(themeSettings?.user_color_rules).forEach((row) => {
    const username = normalizeUsername(row.username);
    const color = normalizeColor(row.color);

    if (username && color) {
      userColors.set(username, color);
    }
  });

  rowsFor(themeSettings?.group_color_rules).forEach((row) => {
    const groupName = normalizeGroupName(row.group_name);
    const color = normalizeColor(row.color);

    if (groupName && color) {
      groupColors.set(groupName, color);
    }
  });

  return {
    applyToMentions: themeSettings?.apply_to_mentions !== false,
    enabled: themeSettings?.enabled !== false,
    groupColors,
    makeColoredNamesBold: themeSettings?.make_colored_names_bold === true,
    useDefaultGroupPalette: themeSettings?.use_default_group_palette === true,
    userColors,
  };
}

export function syncDocumentState(rules) {
  document.body?.classList.toggle(ENABLED_CLASS, rules.enabled);
  document.body?.classList.toggle(
    BOLD_CLASS,
    rules.enabled && rules.makeColoredNamesBold
  );
}

export function applyNameColors(root, rules) {
  if (!rules.enabled || !root) {
    return;
  }

  const targets = collectTargets(root);

  targets.forEach((target) => {
    const context = contextForTarget(target, rules);
    const match = colorForContext(context, rules);
    const paintTargets = collectPaintTargets(target);

    paintTargets.forEach((paintTarget) => {
      if (match) {
        applyColor(paintTarget, match.color, match.source);
      } else {
        clearColor(paintTarget);
      }
    });
  });
}

export function observeNameColorTargets(apply) {
  if (!document.body || typeof MutationObserver === "undefined") {
    return;
  }

  let queued = false;

  const scheduleApply = () => {
    if (queued) {
      return;
    }

    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      apply();
    });
  };

  const observer = new MutationObserver((mutations) => {
    if (
      mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some(
          (node) => node.nodeType === Node.ELEMENT_NODE
        )
      )
    ) {
      scheduleApply();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  return observer;
}

export function colorForContext(context, rules) {
  if (context.username && rules.userColors.has(context.username)) {
    return { color: rules.userColors.get(context.username), source: "user" };
  }

  if (context.groupName && rules.groupColors.has(context.groupName)) {
    return { color: rules.groupColors.get(context.groupName), source: "group" };
  }

  if (context.groupName && rules.useDefaultGroupPalette) {
    return {
      color: paletteColorFor(context.groupName),
      source: "default-group",
    };
  }
}

export function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

export function normalizeGroupName(groupName) {
  const normalized = String(groupName || "")
    .trim()
    .toLowerCase();

  return INVALID_GROUP_NAMES.has(normalized) ? "" : normalized;
}

export function normalizeColor(color) {
  const normalized = String(color || "").trim();

  return SAFE_COLOR_PATTERN.test(normalized) ? normalized : "";
}

function rowsFor(value) {
  return Array.isArray(value)
    ? value.filter((row) => row && typeof row === "object")
    : [];
}

function collectTargets(root) {
  const targets = new Set();

  if (
    root.nodeType === Node.ELEMENT_NODE &&
    root.matches(NAME_TARGET_SELECTOR)
  ) {
    targets.add(root);
  }

  const scope = root.querySelectorAll ? root : document;
  scope.querySelectorAll(NAME_TARGET_SELECTOR).forEach((element) => {
    targets.add(element);
  });

  return targets;
}

function contextForTarget(target, rules) {
  return {
    groupName: groupNameForTarget(target),
    username: usernameForTarget(target, rules),
  };
}

function usernameForTarget(target, rules) {
  if (target.matches("a.mention")) {
    return rules.applyToMentions ? normalizeUsername(target.textContent) : "";
  }

  const userCardTarget = target.matches("[data-user-card]")
    ? target
    : target.querySelector("[data-user-card]");

  if (userCardTarget?.dataset?.userCard) {
    return normalizeUsername(userCardTarget.dataset.userCard);
  }

  const contextualUserCardTarget = target
    .closest(".post-list-item, .topic-post")
    ?.querySelector("[data-user-card]");

  if (contextualUserCardTarget?.dataset?.userCard) {
    return normalizeUsername(contextualUserCardTarget.dataset.userCard);
  }

  const mentionTarget = target.querySelector("a.mention");

  if (rules.applyToMentions && mentionTarget?.textContent) {
    return normalizeUsername(mentionTarget.textContent);
  }

  const userCard = target.closest(".user-card");
  const userCardClass = userCard
    ? Array.from(userCard.classList).find(
        (className) =>
          className.startsWith("user-card-") && className !== "user-card"
      )
    : null;

  return userCardClass
    ? normalizeUsername(userCardClass.replace(/^user-card-/, ""))
    : "";
}

function groupNameForTarget(target) {
  const directGroup = groupNameFromClassList(target.classList);

  if (directGroup) {
    return directGroup;
  }

  const names = target.closest(".names");
  const primaryName = names?.querySelector(".first");
  const primaryGroup = primaryName
    ? groupNameFromClassList(primaryName.classList)
    : "";

  if (primaryGroup) {
    return primaryGroup;
  }

  const groupedContainer = target.closest(".user-card, .post-list-item");

  return groupedContainer
    ? groupNameFromClassList(groupedContainer.classList)
    : "";
}

function groupNameFromClassList(classList) {
  if (!classList) {
    return "";
  }

  const doubleDashGroup = Array.from(classList).find((className) =>
    className.startsWith("group--")
  );

  if (doubleDashGroup) {
    return normalizeGroupName(doubleDashGroup.replace(/^group--/, ""));
  }

  const dashGroup = Array.from(classList).find(
    (className) =>
      className.startsWith("group-") && !className.startsWith("group-post-")
  );

  return dashGroup ? normalizeGroupName(dashGroup.replace(/^group-/, "")) : "";
}

function collectPaintTargets(target) {
  const targets = new Set([target]);

  target
    .querySelectorAll?.("a, .name-username-wrapper, .d-icon")
    .forEach((element) => targets.add(element));

  return targets;
}

function applyColor(element, color, source) {
  element.classList.add(APPLIED_CLASS);
  element.dataset.namecolorSource = source;
  element.style.setProperty("--discourse-namecolor-color", color);
  element.style.setProperty("color", color, "important");
}

function clearColor(element) {
  if (!element.classList.contains(APPLIED_CLASS)) {
    return;
  }

  element.classList.remove(APPLIED_CLASS);
  delete element.dataset.namecolorSource;
  element.style.removeProperty("--discourse-namecolor-color");
  element.style.removeProperty("color");
}

function paletteColorFor(groupName) {
  let hash = 0;

  for (const character of groupName) {
    hash = (hash * 31 + character.charCodeAt(0)) % PALETTE.length;
  }

  return PALETTE[hash];
}
