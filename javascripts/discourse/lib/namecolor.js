import { ajax } from "discourse/lib/ajax";

const APPLIED_CLASS = "discourse-namecolor-name";
const ENABLED_CLASS = "discourse-namecolor-enabled";
const BOLD_CLASS = "discourse-namecolor-bold";
const GROUP_CLASS_PREFIX = "discourse-namecolor-group--";
const MEMBERSHIP_LOOKUP_BATCH_SIZE = 50;

const NAME_TARGET_SELECTOR = [
  ".topic-post .names .first",
  ".topic-post .names .second",
  ".post-list-item .post-member-info.names .name",
  ".user-card .names__primary",
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
const GRADIENT_PATTERN =
  /^(?:repeating-)?(?:linear|radial|conic)-gradient\(.+\)$/i;
const UNSAFE_CSS_VALUE_PATTERN =
  /[;"'{}<>\\]|url\s*\(|image-set\s*\(|expression\s*\(|@import/i;
const COLOR_TOKEN_PATTERN =
  /#[0-9a-f]{3,8}\b|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^()]+\)|var\(--[a-z0-9_-]+\)|\b[a-z][a-z0-9-]*\b/gi;
const NON_COLOR_GRADIENT_WORDS = new Set([
  "at",
  "a98-rgb",
  "bottom",
  "circle",
  "closest-corner",
  "closest-side",
  "conic-gradient",
  "decreasing",
  "display-p3",
  "ellipse",
  "farther-corner",
  "farther-side",
  "farthest-corner",
  "farthest-side",
  "from",
  "hsl",
  "hue",
  "hwb",
  "in",
  "increasing",
  "lab",
  "left",
  "linear-gradient",
  "lch",
  "longer",
  "oklab",
  "oklch",
  "prophoto-rgb",
  "radial-gradient",
  "rec2020",
  "repeating-conic-gradient",
  "repeating-linear-gradient",
  "repeating-radial-gradient",
  "right",
  "shorter",
  "side",
  "srgb",
  "srgb-linear",
  "to",
  "top",
  "xyz",
  "xyz-d50",
  "xyz-d65",
]);

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
    checkedMemberships: new Set(),
    enabled: themeSettings?.enabled !== false,
    groupColors,
    groupNames: Array.from(groupColors.keys()),
    groupLookupFailures: new Set(),
    makeColoredNamesBold: themeSettings?.make_colored_names_bold === true,
    membershipLookupCallback: null,
    membershipLookupInFlight: false,
    membershipLookupScheduled: false,
    pendingMemberships: new Map(),
    useDefaultGroupPalette: themeSettings?.use_default_group_palette === true,
    userColors,
    usernameGroups: new Map(),
  };
}

export function setMembershipLookupCallback(rules, callback) {
  rules.membershipLookupCallback = callback;
}

export function registerNameColorTransformers(api, rules) {
  api.registerValueTransformer("poster-name-class", ({ value, context }) => {
    const groupName = trustLevelGroupNameForUser(context?.user, rules);

    if (!groupName) {
      return value;
    }

    return [...classListForValue(value), classNameForGroup(groupName)];
  });
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
    queueMembershipLookups(context.username, rules);

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

  const groupName = prioritizedGroupNameForContext(context, rules);

  if (groupName && rules.groupColors.has(groupName)) {
    return { color: rules.groupColors.get(groupName), source: "group" };
  }

  if (groupName && rules.useDefaultGroupPalette) {
    return {
      color: paletteColorFor(groupName),
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

  if (SAFE_COLOR_PATTERN.test(normalized)) {
    return normalized;
  }

  return isSafeGradient(normalized) ? normalized : "";
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

  const nameColorGroup = Array.from(classList).find((className) =>
    className.startsWith(GROUP_CLASS_PREFIX)
  );

  if (nameColorGroup) {
    return normalizeGroupName(nameColorGroup.slice(GROUP_CLASS_PREFIX.length));
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
  const gradient = isGradient(color);
  const fallbackColor = gradient ? fallbackColorForGradient(color) : color;

  element.classList.add(APPLIED_CLASS);
  element.dataset.namecolorSource = source;
  element.dataset.namecolorKind = gradient ? "gradient" : "solid";
  element.style.setProperty("--discourse-namecolor-color", fallbackColor);
  element.style.removeProperty("--discourse-namecolor-gradient");
  element.style.removeProperty("background-image");
  element.style.removeProperty("background-clip");
  element.style.removeProperty("-webkit-background-clip");
  element.style.removeProperty("-webkit-text-fill-color");

  if (gradient && !element.classList.contains("d-icon")) {
    element.style.setProperty("--discourse-namecolor-gradient", color);
    element.style.setProperty("background-image", color);
    element.style.setProperty("background-clip", "text");
    element.style.setProperty("-webkit-background-clip", "text");
    element.style.setProperty("-webkit-text-fill-color", "transparent");
    element.style.setProperty("color", "transparent", "important");
  } else {
    element.style.setProperty("color", fallbackColor, "important");
  }
}

function clearColor(element) {
  if (!element.classList.contains(APPLIED_CLASS)) {
    return;
  }

  element.classList.remove(APPLIED_CLASS);
  delete element.dataset.namecolorSource;
  delete element.dataset.namecolorKind;
  element.style.removeProperty("--discourse-namecolor-color");
  element.style.removeProperty("--discourse-namecolor-gradient");
  element.style.removeProperty("background-image");
  element.style.removeProperty("background-clip");
  element.style.removeProperty("-webkit-background-clip");
  element.style.removeProperty("-webkit-text-fill-color");
  element.style.removeProperty("color");
}

function paletteColorFor(groupName) {
  let hash = 0;

  for (const character of groupName) {
    hash = (hash * 31 + character.charCodeAt(0)) % PALETTE.length;
  }

  return PALETTE[hash];
}

function prioritizedGroupNameForContext(context, rules) {
  const candidateGroups = new Set();

  if (context.groupName) {
    candidateGroups.add(context.groupName);
  }

  if (context.username && rules.usernameGroups.has(context.username)) {
    rules.usernameGroups
      .get(context.username)
      .forEach((groupName) => candidateGroups.add(groupName));
  }

  for (const groupName of rules.groupNames) {
    if (candidateGroups.has(groupName)) {
      return groupName;
    }
  }

  return candidateGroups.values().next().value;
}

function trustLevelGroupNameForUser(user, rules) {
  const trustLevel = Number(user?.trust_level);

  if (!Number.isInteger(trustLevel)) {
    return "";
  }

  const groupName = normalizeGroupName(`trust_level_${trustLevel}`);

  return rules.groupColors.has(groupName) ? groupName : "";
}

function classNameForGroup(groupName) {
  return `${GROUP_CLASS_PREFIX}${groupName}`;
}

function classListForValue(value) {
  if (Array.isArray(value)) {
    return value;
  }

  return value ? String(value).split(/\s+/).filter(Boolean) : [];
}

function queueMembershipLookups(username, rules) {
  if (!username || !rules.groupNames.length || rules.userColors.has(username)) {
    return;
  }

  rules.groupNames.forEach((groupName) => {
    if (rules.groupLookupFailures.has(groupName)) {
      return;
    }

    const key = membershipKey(groupName, username);

    if (rules.checkedMemberships.has(key)) {
      return;
    }

    if (!rules.pendingMemberships.has(groupName)) {
      rules.pendingMemberships.set(groupName, new Set());
    }

    rules.pendingMemberships.get(groupName).add(username);
  });

  scheduleMembershipLookup(rules);
}

function scheduleMembershipLookup(rules) {
  if (rules.membershipLookupScheduled || rules.membershipLookupInFlight) {
    return;
  }

  rules.membershipLookupScheduled = true;

  requestAnimationFrame(() => {
    rules.membershipLookupScheduled = false;
    loadQueuedMemberships(rules);
  });
}

async function loadQueuedMemberships(rules) {
  if (rules.membershipLookupInFlight || !rules.pendingMemberships.size) {
    return;
  }

  rules.membershipLookupInFlight = true;

  try {
    const pendingMemberships = rules.pendingMemberships;
    rules.pendingMemberships = new Map();
    let changed = false;

    for (const [groupName, usernames] of pendingMemberships.entries()) {
      const batches = batchUsernames(Array.from(usernames));

      for (const batch of batches) {
        const matchedUsernames = await loadGroupMemberUsernames(
          groupName,
          batch,
          rules
        );

        for (const username of batch) {
          rules.checkedMemberships.add(membershipKey(groupName, username));

          if (matchedUsernames.has(username)) {
            addUsernameGroup(rules, username, groupName);
            changed = true;
          }
        }
      }
    }

    if (changed) {
      rules.membershipLookupCallback?.();
    }
  } finally {
    rules.membershipLookupInFlight = false;

    if (rules.pendingMemberships.size) {
      scheduleMembershipLookup(rules);
    }
  }
}

async function loadGroupMemberUsernames(groupName, usernames, rules) {
  const requestedUsernames = new Set(usernames);

  try {
    const response = await ajax(
      `/groups/${encodeURIComponent(groupName)}/members.json`,
      {
        data: {
          filter: usernames.join(","),
          limit: MEMBERSHIP_LOOKUP_BATCH_SIZE,
        },
      }
    );

    return new Set(
      (response.members || [])
        .map((member) => normalizeUsername(member.username))
        .filter((username) => requestedUsernames.has(username))
    );
  } catch {
    rules.groupLookupFailures.add(groupName);

    return new Set();
  }
}

function addUsernameGroup(rules, username, groupName) {
  if (!rules.usernameGroups.has(username)) {
    rules.usernameGroups.set(username, new Set());
  }

  rules.usernameGroups.get(username).add(groupName);
}

function batchUsernames(usernames) {
  const batches = [];

  for (
    let index = 0;
    index < usernames.length;
    index += MEMBERSHIP_LOOKUP_BATCH_SIZE
  ) {
    batches.push(usernames.slice(index, index + MEMBERSHIP_LOOKUP_BATCH_SIZE));
  }

  return batches;
}

function membershipKey(groupName, username) {
  return `${groupName}:${username}`;
}

function isSafeGradient(value) {
  return (
    GRADIENT_PATTERN.test(value) &&
    value.length <= 512 &&
    !UNSAFE_CSS_VALUE_PATTERN.test(value) &&
    hasBalancedParentheses(value) &&
    supportsCssValue("background-image", value)
  );
}

function isGradient(value) {
  return GRADIENT_PATTERN.test(value);
}

function fallbackColorForGradient(value) {
  COLOR_TOKEN_PATTERN.lastIndex = 0;

  let match;

  while ((match = COLOR_TOKEN_PATTERN.exec(value))) {
    const token = match[0];
    const normalizedToken = token.toLowerCase();

    if (!NON_COLOR_GRADIENT_WORDS.has(normalizedToken)) {
      return token;
    }
  }

  return "var(--primary)";
}

function hasBalancedParentheses(value) {
  let depth = 0;

  for (const character of value) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    }

    if (depth < 0) {
      return false;
    }
  }

  return depth === 0;
}

function supportsCssValue(property, value) {
  return typeof CSS === "undefined" || CSS.supports(property, value);
}
