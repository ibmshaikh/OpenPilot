/**
 * Block skeleton placeholders for async UI loads.
 * Separate from the live agent text shimmer (Thinking / Exploring).
 */

function bar(extraClass = "") {
  const el = document.createElement("div");
  el.className = extraClass ? `skeleton-bar ${extraClass}` : "skeleton-bar";
  el.setAttribute("aria-hidden", "true");
  return el;
}

/** Chat thread: one user bubble + several agent lines. */
export function createThreadSkeleton() {
  const root = document.createElement("div");
  root.className = "thread-skeleton skeleton";
  root.setAttribute("role", "status");
  root.setAttribute("aria-label", "Loading conversation");

  const user = document.createElement("div");
  user.className = "thread-skeleton-user";
  user.append(bar("skeleton-bar--user"), bar("skeleton-bar--user-short"));

  const agent = document.createElement("div");
  agent.className = "thread-skeleton-agent";
  agent.append(
    bar("skeleton-bar--line"),
    bar("skeleton-bar--line"),
    bar("skeleton-bar--line-short"),
    bar("skeleton-bar--block"),
    bar("skeleton-bar--line"),
    bar("skeleton-bar--line-mid")
  );

  root.append(user, agent);
  return root;
}

/**
 * @param {number} [count=5]
 * @param {"chat"|"file"|"card"|"usage"|"default"} [variant="default"]
 */
export function createListSkeleton(count = 5, variant = "default") {
  const root = document.createElement("div");
  root.className = `list-skeleton skeleton list-skeleton--${variant}`;
  root.setAttribute("role", "status");
  root.setAttribute("aria-label", "Loading");

  const n = Math.max(1, Math.min(12, Number(count) || 5));
  for (let i = 0; i < n; i += 1) {
    const row = document.createElement("div");
    row.className = "list-skeleton-row";
    row.setAttribute("aria-hidden", "true");
    if (variant === "card") {
      row.append(bar("skeleton-bar--card-title"), bar("skeleton-bar--card-meta"));
    } else if (variant === "file") {
      row.append(bar("skeleton-bar--icon"), bar("skeleton-bar--file"));
    } else if (variant === "usage") {
      row.append(bar("skeleton-bar--usage"));
    } else {
      // chat / default
      row.append(bar("skeleton-bar--chat"));
    }
    root.appendChild(row);
  }
  return root;
}

/** Replace container contents with a skeleton, or clear skeletons when node is null. */
export function setSkeleton(container, node) {
  if (!container) return;
  if (!node) {
    for (const child of [...container.children]) {
      if (child.classList?.contains("skeleton")) child.remove();
    }
    return;
  }
  container.replaceChildren(node);
}
