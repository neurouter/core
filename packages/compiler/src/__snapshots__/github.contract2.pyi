# github.pyi  (generated; Neurouter compiler 0.1.0; contract 2)
# Call as github.<function>(name=value, ...): keyword arguments only; results are plain data (whole values, no cuts).
# Lists: github.<fn>.pages(..., max_items=500) → all items; github.<fn>.page(...) → Result(.data, .items, .page, .next()).
# Errors: except NotFound / InvalidArgs / Forbidden / WritesDisabled / ConfirmationRequired / RateLimited / Timeout / UpstreamError, or ToolError for all; ops.error(e) → {code, message, next, fields, retry, …}.
# Built-ins: len, range, enumerate, zip, sorted, reversed, min, max, sum, any, all, abs, round, divmod, pow, int, float, str, bool, list, dict, set, frozenset, tuple, isinstance, type, iter, next, repr, chr, ord, hex, print, getattr, hasattr (type takes one argument). No map/filter (use comprehensions); tool results are dicts/lists (d["key"]).
from typing import Any, Literal, NotRequired, TypedDict

class FullRepository(TypedDict):
    full_name: str
    description: str | None
    default_branch: str
    visibility: NotRequired[str]
    open_issues_count: int
    stargazers_count: int
    topics: NotRequired[list[str]]
    html_url: str
    pushed_at: str

class SimpleUser(TypedDict):
    login: str

class ShortBranch(TypedDict):
    name: str
    protected: bool

class GitUser(TypedDict):
    name: NotRequired[str]
    email: NotRequired[str]
    date: NotRequired[str]

class CommitCommitTree(TypedDict):
    sha: str
    url: str

class Verification(TypedDict):
    verified: bool
    reason: str
    payload: str | None
    signature: str | None

class CommitCommit(TypedDict):
    url: str
    author: GitUser | None
    committer: GitUser | None
    message: str
    comment_count: int
    tree: CommitCommitTree
    verification: NotRequired[Verification]

class SimpleUser2(TypedDict):
    name: NotRequired[str | None]
    email: NotRequired[str | None]
    login: str
    id: int
    node_id: str
    avatar_url: str
    gravatar_id: str | None
    url: str
    html_url: str
    followers_url: str
    following_url: str
    gists_url: str
    starred_url: str
    subscriptions_url: str
    organizations_url: str
    repos_url: str
    events_url: str
    received_events_url: str
    type: str
    site_admin: bool
    starred_at: NotRequired[str]

class CommitParentsItem(TypedDict):
    sha: str
    url: str
    html_url: NotRequired[str]

class CommitStats(TypedDict):
    additions: NotRequired[int]
    deletions: NotRequired[int]
    total: NotRequired[int]

class DiffEntry(TypedDict):
    sha: str
    filename: str
    status: Literal["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]
    additions: int
    deletions: int
    changes: int
    blob_url: str
    raw_url: str
    contents_url: str
    patch: NotRequired[str]
    previous_filename: NotRequired[str]

class Commit(TypedDict):
    url: str
    sha: str
    node_id: str
    html_url: str
    comments_url: str
    commit: CommitCommit
    author: SimpleUser2 | None
    committer: SimpleUser2 | None
    parents: list[CommitParentsItem]
    stats: NotRequired[CommitStats]
    files: NotRequired[list[DiffEntry]]

class BranchWithProtectionLinks(TypedDict):
    html: str
    self: str

class ProtectedBranchRequiredStatusCheckChecksItem(TypedDict):
    context: str
    app_id: int | None

class ProtectedBranchRequiredStatusCheck(TypedDict):
    url: NotRequired[str]
    enforcement_level: NotRequired[str]
    contexts: list[str]
    checks: list[ProtectedBranchRequiredStatusCheckChecksItem]
    contexts_url: NotRequired[str]
    strict: NotRequired[bool]

class ProtectedBranchAdminEnforced(TypedDict):
    url: str
    enabled: bool

class ProtectedBranchPullRequestReviewDismissalRestrictions(TypedDict):
    users: NotRequired[list[dict[str, Any]]]
    teams: NotRequired[list[dict[str, Any]]]
    apps: NotRequired[list[dict[str, Any]]]
    url: NotRequired[str]
    users_url: NotRequired[str]
    teams_url: NotRequired[str]

class ProtectedBranchPullRequestReviewBypassPullRequestAllowances(TypedDict):
    users: NotRequired[list[dict[str, Any]]]
    teams: NotRequired[list[dict[str, Any]]]
    apps: NotRequired[list[dict[str, Any]]]

class ProtectedBranchPullRequestReview(TypedDict):
    url: NotRequired[str]
    dismissal_restrictions: NotRequired[ProtectedBranchPullRequestReviewDismissalRestrictions]
    bypass_pull_request_allowances: NotRequired[ProtectedBranchPullRequestReviewBypassPullRequestAllowances]
    dismiss_stale_reviews: bool
    require_code_owner_reviews: bool
    required_approving_review_count: NotRequired[int]
    require_last_push_approval: NotRequired[bool]

class BranchRestrictionPolicyUsersItem(TypedDict):
    login: NotRequired[str]
    id: NotRequired[int]
    node_id: NotRequired[str]
    avatar_url: NotRequired[str]
    gravatar_id: NotRequired[str]
    url: NotRequired[str]
    html_url: NotRequired[str]
    followers_url: NotRequired[str]
    following_url: NotRequired[str]
    gists_url: NotRequired[str]
    starred_url: NotRequired[str]
    subscriptions_url: NotRequired[str]
    organizations_url: NotRequired[str]
    repos_url: NotRequired[str]
    events_url: NotRequired[str]
    received_events_url: NotRequired[str]
    type: NotRequired[str]
    site_admin: NotRequired[bool]

class BranchRestrictionPolicyTeamsItem(TypedDict):
    id: NotRequired[int]
    node_id: NotRequired[str]
    url: NotRequired[str]
    html_url: NotRequired[str]
    name: NotRequired[str]
    slug: NotRequired[str]
    description: NotRequired[str | None]
    privacy: NotRequired[str]
    permission: NotRequired[str]
    members_url: NotRequired[str]
    repositories_url: NotRequired[str]
    parent: NotRequired[str | None]

class BranchRestrictionPolicyAppsItem(TypedDict):
    id: NotRequired[int]
    slug: NotRequired[str]
    node_id: NotRequired[str]
    owner: NotRequired[dict[str, Any]]
    name: NotRequired[str]
    description: NotRequired[str]
    external_url: NotRequired[str]
    html_url: NotRequired[str]
    created_at: NotRequired[str]
    updated_at: NotRequired[str]
    permissions: NotRequired[dict[str, Any]]
    events: NotRequired[list[str]]

class BranchRestrictionPolicy(TypedDict):
    url: str
    users_url: str
    teams_url: str
    apps_url: str
    users: list[BranchRestrictionPolicyUsersItem]
    teams: list[BranchRestrictionPolicyTeamsItem]
    apps: list[BranchRestrictionPolicyAppsItem]

class BranchProtectionRequiredLinearHistory(TypedDict):
    enabled: NotRequired[bool]

class BranchProtectionAllowForcePushes(TypedDict):
    enabled: NotRequired[bool]

class BranchProtectionAllowDeletions(TypedDict):
    enabled: NotRequired[bool]

class BranchProtectionBlockCreations(TypedDict):
    enabled: NotRequired[bool]

class BranchProtectionRequiredConversationResolution(TypedDict):
    enabled: NotRequired[bool]

class BranchProtectionRequiredSignatures(TypedDict):
    url: str
    enabled: bool

class BranchProtectionLockBranch(TypedDict):
    enabled: NotRequired[bool]

class BranchProtectionAllowForkSyncing(TypedDict):
    enabled: NotRequired[bool]

class BranchProtection(TypedDict):
    url: NotRequired[str]
    enabled: NotRequired[bool]
    required_status_checks: NotRequired[ProtectedBranchRequiredStatusCheck]
    enforce_admins: NotRequired[ProtectedBranchAdminEnforced]
    required_pull_request_reviews: NotRequired[ProtectedBranchPullRequestReview]
    restrictions: NotRequired[BranchRestrictionPolicy]
    required_linear_history: NotRequired[BranchProtectionRequiredLinearHistory]
    allow_force_pushes: NotRequired[BranchProtectionAllowForcePushes]
    allow_deletions: NotRequired[BranchProtectionAllowDeletions]
    block_creations: NotRequired[BranchProtectionBlockCreations]
    required_conversation_resolution: NotRequired[BranchProtectionRequiredConversationResolution]
    name: NotRequired[str]
    protection_url: NotRequired[str]
    required_signatures: NotRequired[BranchProtectionRequiredSignatures]
    lock_branch: NotRequired[BranchProtectionLockBranch]
    allow_fork_syncing: NotRequired[BranchProtectionAllowForkSyncing]

class BranchWithProtection(TypedDict):
    name: str
    commit: Commit
    _links: BranchWithProtectionLinks
    protected: bool
    protection: BranchProtection
    protection_url: str
    pattern: NotRequired[str]
    required_approving_review_count: NotRequired[int]

class GitUser2(TypedDict):
    name: NotRequired[str]
    date: NotRequired[str]

class CommitCommit2(TypedDict):
    message: str
    author: GitUser2 | None

class Commit2(TypedDict):
    sha: str
    commit: CommitCommit2

class IssueLabelsItem2(TypedDict):
    id: NotRequired[int]
    node_id: NotRequired[str]
    url: NotRequired[str]
    name: NotRequired[str]
    description: NotRequired[str | None]
    color: NotRequired[str | None]
    default: NotRequired[bool]

class IssuePullRequest(TypedDict):
    url: str | None

class Issue(TypedDict):
    number: int
    title: str
    state: str
    labels: list[str | IssueLabelsItem2]
    comments: int
    created_at: str
    updated_at: str
    html_url: str
    pull_request: NotRequired[IssuePullRequest]
    author: NotRequired[str]

class IssuesCreateArgLabelsItem2(TypedDict):
    id: NotRequired[int]
    name: NotRequired[str]
    description: NotRequired[str | None]
    color: NotRequired[str | None]

class NullableSimpleUser(TypedDict):
    name: NotRequired[str | None]
    email: NotRequired[str | None]
    login: str
    id: int
    node_id: str
    avatar_url: str
    gravatar_id: str | None
    url: str
    html_url: str
    followers_url: str
    following_url: str
    gists_url: str
    starred_url: str
    subscriptions_url: str
    organizations_url: str
    repos_url: str
    events_url: str
    received_events_url: str
    type: str
    site_admin: bool
    starred_at: NotRequired[str]

class Milestone(TypedDict):
    url: str
    html_url: str
    labels_url: str
    id: int
    node_id: str
    number: int
    state: Literal["open", "closed"]
    title: str
    description: str | None
    creator: NullableSimpleUser | None
    open_issues: int
    closed_issues: int
    created_at: str
    updated_at: str
    closed_at: str | None
    due_on: str | None

class IssuePullRequest2(TypedDict):
    merged_at: NotRequired[str | None]
    diff_url: str | None
    html_url: str | None
    patch_url: str | None
    url: str | None

class LicenseSimple(TypedDict):
    key: str
    name: str
    url: str | None
    spdx_id: str | None
    node_id: str
    html_url: NotRequired[str]

class RepositoryPermissions(TypedDict):
    admin: bool
    pull: bool
    triage: NotRequired[bool]
    push: bool
    maintain: NotRequired[bool]

class RepositoryTemplateRepositoryOwner(TypedDict):
    login: NotRequired[str]
    id: NotRequired[int]
    node_id: NotRequired[str]
    avatar_url: NotRequired[str]
    gravatar_id: NotRequired[str]
    url: NotRequired[str]
    html_url: NotRequired[str]
    followers_url: NotRequired[str]
    following_url: NotRequired[str]
    gists_url: NotRequired[str]
    starred_url: NotRequired[str]
    subscriptions_url: NotRequired[str]
    organizations_url: NotRequired[str]
    repos_url: NotRequired[str]
    events_url: NotRequired[str]
    received_events_url: NotRequired[str]
    type: NotRequired[str]
    site_admin: NotRequired[bool]

class RepositoryTemplateRepositoryPermissions(TypedDict):
    admin: NotRequired[bool]
    maintain: NotRequired[bool]
    push: NotRequired[bool]
    triage: NotRequired[bool]
    pull: NotRequired[bool]

class RepositoryTemplateRepository(TypedDict):
    id: NotRequired[int]
    node_id: NotRequired[str]
    name: NotRequired[str]
    full_name: NotRequired[str]
    owner: NotRequired[RepositoryTemplateRepositoryOwner]
    private: NotRequired[bool]
    html_url: NotRequired[str]
    description: NotRequired[str]
    fork: NotRequired[bool]
    url: NotRequired[str]
    archive_url: NotRequired[str]
    assignees_url: NotRequired[str]
    blobs_url: NotRequired[str]
    branches_url: NotRequired[str]
    collaborators_url: NotRequired[str]
    comments_url: NotRequired[str]
    commits_url: NotRequired[str]
    compare_url: NotRequired[str]
    contents_url: NotRequired[str]
    contributors_url: NotRequired[str]
    deployments_url: NotRequired[str]
    downloads_url: NotRequired[str]
    events_url: NotRequired[str]
    forks_url: NotRequired[str]
    git_commits_url: NotRequired[str]
    git_refs_url: NotRequired[str]
    git_tags_url: NotRequired[str]
    git_url: NotRequired[str]
    issue_comment_url: NotRequired[str]
    issue_events_url: NotRequired[str]
    issues_url: NotRequired[str]
    keys_url: NotRequired[str]
    labels_url: NotRequired[str]
    languages_url: NotRequired[str]
    merges_url: NotRequired[str]
    milestones_url: NotRequired[str]
    notifications_url: NotRequired[str]
    pulls_url: NotRequired[str]
    releases_url: NotRequired[str]
    ssh_url: NotRequired[str]
    stargazers_url: NotRequired[str]
    statuses_url: NotRequired[str]
    subscribers_url: NotRequired[str]
    subscription_url: NotRequired[str]
    tags_url: NotRequired[str]
    teams_url: NotRequired[str]
    trees_url: NotRequired[str]
    clone_url: NotRequired[str]
    mirror_url: NotRequired[str]
    hooks_url: NotRequired[str]
    svn_url: NotRequired[str]
    homepage: NotRequired[str]
    language: NotRequired[str]
    forks_count: NotRequired[int]
    stargazers_count: NotRequired[int]
    watchers_count: NotRequired[int]
    size: NotRequired[int]
    default_branch: NotRequired[str]
    open_issues_count: NotRequired[int]
    is_template: NotRequired[bool]
    topics: NotRequired[list[str]]
    has_issues: NotRequired[bool]
    has_projects: NotRequired[bool]
    has_wiki: NotRequired[bool]
    has_pages: NotRequired[bool]
    has_downloads: NotRequired[bool]
    archived: NotRequired[bool]
    disabled: NotRequired[bool]
    visibility: NotRequired[str]
    pushed_at: NotRequired[str]
    created_at: NotRequired[str]
    updated_at: NotRequired[str]
    permissions: NotRequired[RepositoryTemplateRepositoryPermissions]
    allow_rebase_merge: NotRequired[bool]
    temp_clone_token: NotRequired[str]
    allow_squash_merge: NotRequired[bool]
    allow_auto_merge: NotRequired[bool]
    delete_branch_on_merge: NotRequired[bool]
    allow_update_branch: NotRequired[bool]
    use_squash_pr_title_as_default: NotRequired[bool]
    squash_merge_commit_title: NotRequired[Literal["PR_TITLE", "COMMIT_OR_PR_TITLE"]]
    squash_merge_commit_message: NotRequired[Literal["PR_BODY", "COMMIT_MESSAGES", "BLANK"]]
    merge_commit_title: NotRequired[Literal["PR_TITLE", "MERGE_MESSAGE"]]
    merge_commit_message: NotRequired[Literal["PR_BODY", "PR_TITLE", "BLANK"]]
    allow_merge_commit: NotRequired[bool]
    subscribers_count: NotRequired[int]
    network_count: NotRequired[int]

class Repository(TypedDict):
    id: int
    node_id: str
    name: str
    full_name: str
    license: LicenseSimple | None
    organization: NotRequired[NullableSimpleUser | None]
    forks: int
    permissions: NotRequired[RepositoryPermissions]
    owner: SimpleUser2
    private: bool
    html_url: str
    description: str | None
    fork: bool
    url: str
    archive_url: str
    assignees_url: str
    blobs_url: str
    branches_url: str
    collaborators_url: str
    comments_url: str
    commits_url: str
    compare_url: str
    contents_url: str
    contributors_url: str
    deployments_url: str
    downloads_url: str
    events_url: str
    forks_url: str
    git_commits_url: str
    git_refs_url: str
    git_tags_url: str
    git_url: str
    issue_comment_url: str
    issue_events_url: str
    issues_url: str
    keys_url: str
    labels_url: str
    languages_url: str
    merges_url: str
    milestones_url: str
    notifications_url: str
    pulls_url: str
    releases_url: str
    ssh_url: str
    stargazers_url: str
    statuses_url: str
    subscribers_url: str
    subscription_url: str
    tags_url: str
    teams_url: str
    trees_url: str
    clone_url: str
    mirror_url: str | None
    hooks_url: str
    svn_url: str
    homepage: str | None
    language: str | None
    forks_count: int
    stargazers_count: int
    watchers_count: int
    size: int
    default_branch: str
    open_issues_count: int
    is_template: NotRequired[bool]
    topics: NotRequired[list[str]]
    has_issues: bool
    has_projects: bool
    has_wiki: bool
    has_pages: bool
    has_downloads: bool
    archived: bool
    disabled: bool
    visibility: NotRequired[str]
    pushed_at: str | None
    created_at: str | None
    updated_at: str | None
    allow_rebase_merge: NotRequired[bool]
    template_repository: NotRequired[RepositoryTemplateRepository | None]
    temp_clone_token: NotRequired[str]
    allow_squash_merge: NotRequired[bool]
    allow_auto_merge: NotRequired[bool]
    delete_branch_on_merge: NotRequired[bool]
    allow_update_branch: NotRequired[bool]
    use_squash_pr_title_as_default: NotRequired[bool]
    squash_merge_commit_title: NotRequired[Literal["PR_TITLE", "COMMIT_OR_PR_TITLE"]]
    squash_merge_commit_message: NotRequired[Literal["PR_BODY", "COMMIT_MESSAGES", "BLANK"]]
    merge_commit_title: NotRequired[Literal["PR_TITLE", "MERGE_MESSAGE"]]
    merge_commit_message: NotRequired[Literal["PR_BODY", "PR_TITLE", "BLANK"]]
    allow_merge_commit: NotRequired[bool]
    allow_forking: NotRequired[bool]
    web_commit_signoff_required: NotRequired[bool]
    subscribers_count: NotRequired[int]
    network_count: NotRequired[int]
    open_issues: int
    watchers: int
    master_branch: NotRequired[str]
    starred_at: NotRequired[str]
    anonymous_access_enabled: NotRequired[bool]

class NullableIntegrationPermissions(TypedDict):
    issues: NotRequired[str]
    checks: NotRequired[str]
    metadata: NotRequired[str]
    contents: NotRequired[str]
    deployments: NotRequired[str]

class NullableIntegration(TypedDict):
    id: int
    slug: NotRequired[str]
    node_id: str
    owner: NullableSimpleUser | None
    name: str
    description: str | None
    external_url: str
    html_url: str
    created_at: str
    updated_at: str
    permissions: NullableIntegrationPermissions
    events: list[str]
    installations_count: NotRequired[int]
    client_id: NotRequired[str]
    client_secret: NotRequired[str]
    webhook_secret: NotRequired[str | None]
    pem: NotRequired[str]

ReactionRollup = TypedDict("ReactionRollup", {
    "url": str,
    "total_count": int,
    "+1": int,
    "-1": int,
    "laugh": int,
    "confused": int,
    "heart": int,
    "hooray": int,
    "eyes": int,
    "rocket": int,
})

class Issue2(TypedDict):
    id: int
    node_id: str
    url: str
    repository_url: str
    labels_url: str
    comments_url: str
    events_url: str
    html_url: str
    number: int
    state: str
    state_reason: NotRequired[Literal["completed", "reopened", "not_planned"]]
    title: str
    body: NotRequired[str | None]
    user: SimpleUser2 | None
    labels: list[str | IssueLabelsItem2]
    assignee: NullableSimpleUser | None
    assignees: NotRequired[list[SimpleUser2] | None]
    milestone: Milestone | None
    locked: bool
    active_lock_reason: NotRequired[str | None]
    comments: int
    pull_request: NotRequired[IssuePullRequest2]
    closed_at: str | None
    created_at: str
    updated_at: str
    draft: NotRequired[bool]
    closed_by: NotRequired[NullableSimpleUser | None]
    body_html: NotRequired[str]
    body_text: NotRequired[str]
    timeline_url: NotRequired[str]
    repository: NotRequired[Repository]
    performed_via_github_app: NotRequired[NullableIntegration | None]
    author_association: Literal["COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "MEMBER", "NONE", "OWNER"]
    reactions: NotRequired[ReactionRollup]

class IssueComment(TypedDict):
    id: int
    user: SimpleUser | None
    body: NotRequired[str]
    created_at: str
    issue_url: str

class GitHubAppPermissions(TypedDict):
    issues: NotRequired[str]
    checks: NotRequired[str]
    metadata: NotRequired[str]
    contents: NotRequired[str]
    deployments: NotRequired[str]

class GitHubApp(TypedDict):
    id: int
    slug: NotRequired[str]
    node_id: str
    owner: SimpleUser2 | None
    name: str
    description: str | None
    external_url: str
    html_url: str
    created_at: str
    updated_at: str
    permissions: GitHubAppPermissions
    events: list[str]
    installations_count: NotRequired[int]
    client_id: NotRequired[str]
    client_secret: NotRequired[str]
    webhook_secret: NotRequired[str | None]
    pem: NotRequired[str]

class IssueComment2(TypedDict):
    id: int
    node_id: str
    url: str
    body: NotRequired[str]
    body_text: NotRequired[str]
    body_html: NotRequired[str]
    html_url: str
    user: SimpleUser2 | None
    created_at: str
    updated_at: str
    issue_url: str
    author_association: Literal["COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "MEMBER", "NONE", "OWNER"]
    performed_via_github_app: NotRequired[GitHubApp | None]
    reactions: NotRequired[ReactionRollup]

class SimpleUser3(TypedDict):
    name: NotRequired[str | None]
    email: NotRequired[str | None]
    login: str
    id: int
    node_id: str
    avatar_url: str
    url: str
    html_url: str
    followers_url: str
    following_url: str
    gists_url: str
    starred_url: str
    subscriptions_url: str
    organizations_url: str
    repos_url: str
    events_url: str
    received_events_url: str
    type: str
    site_admin: bool
    starred_at: NotRequired[str]

class Issue3(TypedDict):
    id: int
    node_id: str
    url: str
    repository_url: str
    labels_url: str
    comments_url: str
    events_url: str
    html_url: str
    number: int
    state: str
    state_reason: NotRequired[Literal["completed", "reopened", "not_planned"]]
    title: str
    body: NotRequired[str | None]
    user: SimpleUser3 | None
    labels: list[str | IssueLabelsItem2]
    assignee: NullableSimpleUser | None
    assignees: NotRequired[list[SimpleUser2] | None]
    milestone: Milestone | None
    locked: bool
    active_lock_reason: NotRequired[str | None]
    comments: int
    pull_request: NotRequired[IssuePullRequest2]
    closed_at: str | None
    created_at: str
    updated_at: str
    draft: NotRequired[bool]
    closed_by: NotRequired[NullableSimpleUser | None]
    body_html: NotRequired[str]
    body_text: NotRequired[str]
    timeline_url: NotRequired[str]
    repository: NotRequired[Repository]
    author_association: Literal["COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "MEMBER", "NONE", "OWNER"]

class IssuesUpdateArgLabelsItem2(TypedDict):
    id: NotRequired[int]
    name: NotRequired[str]
    description: NotRequired[str | None]
    color: NotRequired[str | None]

class IssueComment3(TypedDict):
    id: int
    body: NotRequired[str]
    created_at: str
    html_url: str
    author: NotRequired[str]

class Label(TypedDict):
    name: str

class IssuesSetLabelsArgBody1(TypedDict):
    labels: NotRequired[list[str]]

class IssuesSetLabelsArgBody3LabelsItem(TypedDict):
    name: str

class IssuesSetLabelsArgBody3(TypedDict):
    labels: NotRequired[list[IssuesSetLabelsArgBody3LabelsItem]]

class IssuesSetLabelsArgBody4Item(TypedDict):
    name: str

class Label2(TypedDict):
    id: int
    node_id: str
    url: str
    name: str
    description: str | None
    color: str
    default: bool

class IssuesAddLabelsArgBody1(TypedDict):
    labels: NotRequired[list[str]]

class IssuesAddLabelsArgBody3LabelsItem(TypedDict):
    name: str

class IssuesAddLabelsArgBody3(TypedDict):
    labels: NotRequired[list[IssuesAddLabelsArgBody3LabelsItem]]

class IssuesAddLabelsArgBody4Item(TypedDict):
    name: str

class Label3(TypedDict):
    name: str
    color: str
    description: str | None

class Milestone2(TypedDict):
    number: int
    title: str
    state: Literal["open", "closed"]
    due_on: str | None
    open_issues: int
    closed_issues: int

class Milestone3(TypedDict):
    url: str
    html_url: str
    labels_url: str
    id: int
    node_id: str
    number: int
    state: Literal["open", "closed"]
    title: str
    description: str | None
    creator: SimpleUser2 | None
    open_issues: int
    closed_issues: int
    created_at: str
    updated_at: str
    closed_at: str | None
    due_on: str | None

class PullRequestSimpleHead(TypedDict):
    ref: str

class PullRequestSimpleBase(TypedDict):
    ref: str

class PullRequestSimple(TypedDict):
    number: int
    title: str
    state: str
    draft: NotRequired[bool]
    head: PullRequestSimpleHead
    base: PullRequestSimpleBase
    created_at: str
    html_url: str
    author: NotRequired[str]

class PullRequestLabelsItem(TypedDict):
    id: int
    node_id: str
    url: str
    name: str
    description: str | None
    color: str
    default: bool

class TeamSimple(TypedDict):
    id: int
    node_id: str
    url: str
    members_url: str
    name: str
    description: str | None
    permission: str
    privacy: NotRequired[str]
    html_url: str
    repositories_url: str
    slug: str
    ldap_dn: NotRequired[str]

class PullRequestHeadRepoOwner(TypedDict):
    avatar_url: str
    events_url: str
    followers_url: str
    following_url: str
    gists_url: str
    gravatar_id: str | None
    html_url: str
    id: int
    node_id: str
    login: str
    organizations_url: str
    received_events_url: str
    repos_url: str
    site_admin: bool
    starred_url: str
    subscriptions_url: str
    type: str
    url: str

class PullRequestHeadRepoPermissions(TypedDict):
    admin: bool
    maintain: NotRequired[bool]
    push: bool
    triage: NotRequired[bool]
    pull: bool

class PullRequestHeadRepoLicense(TypedDict):
    key: str
    name: str
    url: str | None
    spdx_id: str | None
    node_id: str

class PullRequestHeadRepo(TypedDict):
    archive_url: str
    assignees_url: str
    blobs_url: str
    branches_url: str
    collaborators_url: str
    comments_url: str
    commits_url: str
    compare_url: str
    contents_url: str
    contributors_url: str
    deployments_url: str
    description: str | None
    downloads_url: str
    events_url: str
    fork: bool
    forks_url: str
    full_name: str
    git_commits_url: str
    git_refs_url: str
    git_tags_url: str
    hooks_url: str
    html_url: str
    id: int
    node_id: str
    issue_comment_url: str
    issue_events_url: str
    issues_url: str
    keys_url: str
    labels_url: str
    languages_url: str
    merges_url: str
    milestones_url: str
    name: str
    notifications_url: str
    owner: PullRequestHeadRepoOwner
    private: bool
    pulls_url: str
    releases_url: str
    stargazers_url: str
    statuses_url: str
    subscribers_url: str
    subscription_url: str
    tags_url: str
    teams_url: str
    trees_url: str
    url: str
    clone_url: str
    default_branch: str
    forks: int
    forks_count: int
    git_url: str
    has_downloads: bool
    has_issues: bool
    has_projects: bool
    has_wiki: bool
    has_pages: bool
    homepage: str | None
    language: str | None
    master_branch: NotRequired[str]
    archived: bool
    disabled: bool
    visibility: NotRequired[str]
    mirror_url: str | None
    open_issues: int
    open_issues_count: int
    permissions: NotRequired[PullRequestHeadRepoPermissions]
    temp_clone_token: NotRequired[str]
    allow_merge_commit: NotRequired[bool]
    allow_squash_merge: NotRequired[bool]
    allow_rebase_merge: NotRequired[bool]
    license: PullRequestHeadRepoLicense | None
    pushed_at: str
    size: int
    ssh_url: str
    stargazers_count: int
    svn_url: str
    topics: NotRequired[list[str]]
    watchers: int
    watchers_count: int
    created_at: str
    updated_at: str
    allow_forking: NotRequired[bool]
    is_template: NotRequired[bool]
    web_commit_signoff_required: NotRequired[bool]

class PullRequestHeadUser(TypedDict):
    avatar_url: str
    events_url: str
    followers_url: str
    following_url: str
    gists_url: str
    gravatar_id: str | None
    html_url: str
    id: int
    node_id: str
    login: str
    organizations_url: str
    received_events_url: str
    repos_url: str
    site_admin: bool
    starred_url: str
    subscriptions_url: str
    type: str
    url: str

class PullRequestHead(TypedDict):
    label: str
    ref: str
    repo: PullRequestHeadRepo | None
    sha: str
    user: PullRequestHeadUser

class PullRequestBaseRepoOwner(TypedDict):
    avatar_url: str
    events_url: str
    followers_url: str
    following_url: str
    gists_url: str
    gravatar_id: str | None
    html_url: str
    id: int
    node_id: str
    login: str
    organizations_url: str
    received_events_url: str
    repos_url: str
    site_admin: bool
    starred_url: str
    subscriptions_url: str
    type: str
    url: str

class PullRequestBaseRepoPermissions(TypedDict):
    admin: bool
    maintain: NotRequired[bool]
    push: bool
    triage: NotRequired[bool]
    pull: bool

class PullRequestBaseRepo(TypedDict):
    archive_url: str
    assignees_url: str
    blobs_url: str
    branches_url: str
    collaborators_url: str
    comments_url: str
    commits_url: str
    compare_url: str
    contents_url: str
    contributors_url: str
    deployments_url: str
    description: str | None
    downloads_url: str
    events_url: str
    fork: bool
    forks_url: str
    full_name: str
    git_commits_url: str
    git_refs_url: str
    git_tags_url: str
    hooks_url: str
    html_url: str
    id: int
    is_template: NotRequired[bool]
    node_id: str
    issue_comment_url: str
    issue_events_url: str
    issues_url: str
    keys_url: str
    labels_url: str
    languages_url: str
    merges_url: str
    milestones_url: str
    name: str
    notifications_url: str
    owner: PullRequestBaseRepoOwner
    private: bool
    pulls_url: str
    releases_url: str
    stargazers_url: str
    statuses_url: str
    subscribers_url: str
    subscription_url: str
    tags_url: str
    teams_url: str
    trees_url: str
    url: str
    clone_url: str
    default_branch: str
    forks: int
    forks_count: int
    git_url: str
    has_downloads: bool
    has_issues: bool
    has_projects: bool
    has_wiki: bool
    has_pages: bool
    homepage: str | None
    language: str | None
    master_branch: NotRequired[str]
    archived: bool
    disabled: bool
    visibility: NotRequired[str]
    mirror_url: str | None
    open_issues: int
    open_issues_count: int
    permissions: NotRequired[PullRequestBaseRepoPermissions]
    temp_clone_token: NotRequired[str]
    allow_merge_commit: NotRequired[bool]
    allow_squash_merge: NotRequired[bool]
    allow_rebase_merge: NotRequired[bool]
    license: LicenseSimple | None
    pushed_at: str
    size: int
    ssh_url: str
    stargazers_count: int
    svn_url: str
    topics: NotRequired[list[str]]
    watchers: int
    watchers_count: int
    created_at: str
    updated_at: str
    allow_forking: NotRequired[bool]
    web_commit_signoff_required: NotRequired[bool]

class PullRequestBaseUser(TypedDict):
    avatar_url: str
    events_url: str
    followers_url: str
    following_url: str
    gists_url: str
    gravatar_id: str | None
    html_url: str
    id: int
    node_id: str
    login: str
    organizations_url: str
    received_events_url: str
    repos_url: str
    site_admin: bool
    starred_url: str
    subscriptions_url: str
    type: str
    url: str

class PullRequestBase(TypedDict):
    label: str
    ref: str
    repo: PullRequestBaseRepo
    sha: str
    user: PullRequestBaseUser

class Link(TypedDict):
    href: str

class PullRequestLinks(TypedDict):
    comments: Link
    commits: Link
    statuses: Link
    html: Link
    issue: Link
    review_comments: Link
    review_comment: Link
    self: Link

class AutoMerge(TypedDict):
    enabled_by: SimpleUser2
    merge_method: Literal["merge", "squash", "rebase"]
    commit_title: str
    commit_message: str

class PullRequest(TypedDict):
    url: str
    id: int
    node_id: str
    html_url: str
    diff_url: str
    patch_url: str
    issue_url: str
    commits_url: str
    review_comments_url: str
    review_comment_url: str
    comments_url: str
    statuses_url: str
    number: int
    state: Literal["open", "closed"]
    locked: bool
    title: str
    user: SimpleUser2 | None
    body: str | None
    labels: list[PullRequestLabelsItem]
    milestone: Milestone | None
    active_lock_reason: NotRequired[str | None]
    created_at: str
    updated_at: str
    closed_at: str | None
    merged_at: str | None
    merge_commit_sha: str | None
    assignee: NullableSimpleUser | None
    assignees: NotRequired[list[SimpleUser2] | None]
    requested_reviewers: NotRequired[list[SimpleUser2] | None]
    requested_teams: NotRequired[list[TeamSimple] | None]
    head: PullRequestHead
    base: PullRequestBase
    _links: PullRequestLinks
    author_association: Literal["COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "MEMBER", "NONE", "OWNER"]
    auto_merge: AutoMerge | None
    draft: NotRequired[bool]
    merged: bool
    mergeable: bool | None
    rebaseable: NotRequired[bool | None]
    mergeable_state: str
    merged_by: NullableSimpleUser | None
    comments: int
    review_comments: int
    maintainer_can_modify: bool
    commits: int
    additions: int
    deletions: int
    changed_files: int

class PullRequestReviewComment(TypedDict):
    id: int
    user: SimpleUser
    body: str
    path: str
    line: NotRequired[int]

class GitUser3(TypedDict):
    name: NotRequired[str]

class CommitCommit3(TypedDict):
    message: str
    author: GitUser3 | None

class Commit3(TypedDict):
    sha: str
    commit: CommitCommit3

class DiffEntry2(TypedDict):
    filename: str
    status: Literal["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]
    additions: int
    deletions: int

class PullsMergeArgBody(TypedDict):
    commit_title: NotRequired[str]
    commit_message: NotRequired[str]
    sha: NotRequired[str]
    merge_method: NotRequired[Literal["merge", "squash", "rebase"]]

class PullRequestMergeResult(TypedDict):
    sha: str
    merged: bool
    message: str

class PullRequestSimpleLabelsItem(TypedDict):
    id: int
    node_id: str
    url: str
    name: str
    description: str
    color: str
    default: bool

class TeamPermissions(TypedDict):
    pull: bool
    triage: bool
    push: bool
    maintain: bool
    admin: bool

class Team(TypedDict):
    id: int
    node_id: str
    name: str
    slug: str
    description: str | None
    privacy: NotRequired[str]
    permission: str
    permissions: NotRequired[TeamPermissions]
    url: str
    html_url: str
    members_url: str
    repositories_url: str
    parent: TeamSimple | None

class RepositoryTemplateRepository2(TypedDict):
    id: NotRequired[int]
    node_id: NotRequired[str]
    name: NotRequired[str]
    full_name: NotRequired[str]
    owner: NotRequired[dict[str, Any]]
    private: NotRequired[bool]
    html_url: NotRequired[str]
    description: NotRequired[str]
    fork: NotRequired[bool]
    url: NotRequired[str]
    archive_url: NotRequired[str]
    assignees_url: NotRequired[str]
    blobs_url: NotRequired[str]
    branches_url: NotRequired[str]
    collaborators_url: NotRequired[str]
    comments_url: NotRequired[str]
    commits_url: NotRequired[str]
    compare_url: NotRequired[str]
    contents_url: NotRequired[str]
    contributors_url: NotRequired[str]
    deployments_url: NotRequired[str]
    downloads_url: NotRequired[str]
    events_url: NotRequired[str]
    forks_url: NotRequired[str]
    git_commits_url: NotRequired[str]
    git_refs_url: NotRequired[str]
    git_tags_url: NotRequired[str]
    git_url: NotRequired[str]
    issue_comment_url: NotRequired[str]
    issue_events_url: NotRequired[str]
    issues_url: NotRequired[str]
    keys_url: NotRequired[str]
    labels_url: NotRequired[str]
    languages_url: NotRequired[str]
    merges_url: NotRequired[str]
    milestones_url: NotRequired[str]
    notifications_url: NotRequired[str]
    pulls_url: NotRequired[str]
    releases_url: NotRequired[str]
    ssh_url: NotRequired[str]
    stargazers_url: NotRequired[str]
    statuses_url: NotRequired[str]
    subscribers_url: NotRequired[str]
    subscription_url: NotRequired[str]
    tags_url: NotRequired[str]
    teams_url: NotRequired[str]
    trees_url: NotRequired[str]
    clone_url: NotRequired[str]
    mirror_url: NotRequired[str]
    hooks_url: NotRequired[str]
    svn_url: NotRequired[str]
    homepage: NotRequired[str]
    language: NotRequired[str]
    forks_count: NotRequired[int]
    stargazers_count: NotRequired[int]
    watchers_count: NotRequired[int]
    size: NotRequired[int]
    default_branch: NotRequired[str]
    open_issues_count: NotRequired[int]
    is_template: NotRequired[bool]
    topics: NotRequired[list[str]]
    has_issues: NotRequired[bool]
    has_projects: NotRequired[bool]
    has_wiki: NotRequired[bool]
    has_pages: NotRequired[bool]
    has_downloads: NotRequired[bool]
    archived: NotRequired[bool]
    disabled: NotRequired[bool]
    visibility: NotRequired[str]
    pushed_at: NotRequired[str]
    created_at: NotRequired[str]
    updated_at: NotRequired[str]
    permissions: NotRequired[dict[str, Any]]
    allow_rebase_merge: NotRequired[bool]
    temp_clone_token: NotRequired[str]
    allow_squash_merge: NotRequired[bool]
    allow_auto_merge: NotRequired[bool]
    delete_branch_on_merge: NotRequired[bool]
    allow_update_branch: NotRequired[bool]
    use_squash_pr_title_as_default: NotRequired[bool]
    squash_merge_commit_title: NotRequired[Literal["PR_TITLE", "COMMIT_OR_PR_TITLE"]]
    squash_merge_commit_message: NotRequired[Literal["PR_BODY", "COMMIT_MESSAGES", "BLANK"]]
    merge_commit_title: NotRequired[Literal["PR_TITLE", "MERGE_MESSAGE"]]
    merge_commit_message: NotRequired[Literal["PR_BODY", "PR_TITLE", "BLANK"]]
    allow_merge_commit: NotRequired[bool]
    subscribers_count: NotRequired[int]
    network_count: NotRequired[int]

class Repository2(TypedDict):
    id: int
    node_id: str
    name: str
    full_name: str
    license: LicenseSimple | None
    organization: NotRequired[NullableSimpleUser | None]
    forks: int
    permissions: NotRequired[RepositoryPermissions]
    owner: SimpleUser2
    private: bool
    html_url: str
    description: str | None
    fork: bool
    url: str
    archive_url: str
    assignees_url: str
    blobs_url: str
    branches_url: str
    collaborators_url: str
    comments_url: str
    commits_url: str
    compare_url: str
    contents_url: str
    contributors_url: str
    deployments_url: str
    downloads_url: str
    events_url: str
    forks_url: str
    git_commits_url: str
    git_refs_url: str
    git_tags_url: str
    git_url: str
    issue_comment_url: str
    issue_events_url: str
    issues_url: str
    keys_url: str
    labels_url: str
    languages_url: str
    merges_url: str
    milestones_url: str
    notifications_url: str
    pulls_url: str
    releases_url: str
    ssh_url: str
    stargazers_url: str
    statuses_url: str
    subscribers_url: str
    subscription_url: str
    tags_url: str
    teams_url: str
    trees_url: str
    clone_url: str
    mirror_url: str | None
    hooks_url: str
    svn_url: str
    homepage: str | None
    language: str | None
    forks_count: int
    stargazers_count: int
    watchers_count: int
    size: int
    default_branch: str
    open_issues_count: int
    is_template: NotRequired[bool]
    topics: NotRequired[list[str]]
    has_issues: bool
    has_projects: bool
    has_wiki: bool
    has_pages: bool
    has_downloads: bool
    archived: bool
    disabled: bool
    visibility: NotRequired[str]
    pushed_at: str | None
    created_at: str | None
    updated_at: str | None
    allow_rebase_merge: NotRequired[bool]
    template_repository: NotRequired[RepositoryTemplateRepository2 | None]
    temp_clone_token: NotRequired[str]
    allow_squash_merge: NotRequired[bool]
    allow_auto_merge: NotRequired[bool]
    delete_branch_on_merge: NotRequired[bool]
    allow_update_branch: NotRequired[bool]
    use_squash_pr_title_as_default: NotRequired[bool]
    squash_merge_commit_title: NotRequired[Literal["PR_TITLE", "COMMIT_OR_PR_TITLE"]]
    squash_merge_commit_message: NotRequired[Literal["PR_BODY", "COMMIT_MESSAGES", "BLANK"]]
    merge_commit_title: NotRequired[Literal["PR_TITLE", "MERGE_MESSAGE"]]
    merge_commit_message: NotRequired[Literal["PR_BODY", "PR_TITLE", "BLANK"]]
    allow_merge_commit: NotRequired[bool]
    allow_forking: NotRequired[bool]
    web_commit_signoff_required: NotRequired[bool]
    subscribers_count: NotRequired[int]
    network_count: NotRequired[int]
    open_issues: int
    watchers: int
    master_branch: NotRequired[str]
    starred_at: NotRequired[str]
    anonymous_access_enabled: NotRequired[bool]

class PullRequestSimpleHead2(TypedDict):
    label: str
    ref: str
    repo: Repository2
    sha: str
    user: NullableSimpleUser | None

class PullRequestSimpleBase2(TypedDict):
    label: str
    ref: str
    repo: Repository2
    sha: str
    user: NullableSimpleUser | None

class PullRequestSimpleLinks(TypedDict):
    comments: Link
    commits: Link
    statuses: Link
    html: Link
    issue: Link
    review_comments: Link
    review_comment: Link
    self: Link

class PullRequestSimple2(TypedDict):
    url: str
    id: int
    node_id: str
    html_url: str
    diff_url: str
    patch_url: str
    issue_url: str
    commits_url: str
    review_comments_url: str
    review_comment_url: str
    comments_url: str
    statuses_url: str
    number: int
    state: str
    locked: bool
    title: str
    user: SimpleUser2 | None
    body: str | None
    labels: list[PullRequestSimpleLabelsItem]
    milestone: Milestone | None
    active_lock_reason: NotRequired[str | None]
    created_at: str
    updated_at: str
    closed_at: str | None
    merged_at: str | None
    merge_commit_sha: str | None
    assignee: NullableSimpleUser | None
    assignees: NotRequired[list[SimpleUser2] | None]
    requested_reviewers: NotRequired[list[SimpleUser2] | None]
    requested_teams: NotRequired[list[Team] | None]
    head: PullRequestSimpleHead2
    base: PullRequestSimpleBase2
    _links: PullRequestSimpleLinks
    author_association: Literal["COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "MEMBER", "NONE", "OWNER"]
    auto_merge: AutoMerge | None
    draft: NotRequired[bool]

class PullRequestReview(TypedDict):
    id: int
    user: SimpleUser | None
    state: str
    submitted_at: NotRequired[str]

class PullsCreateReviewArgCommentsItem(TypedDict):
    path: str
    position: NotRequired[int]
    body: str
    line: NotRequired[int]
    side: NotRequired[str]
    start_line: NotRequired[int]
    start_side: NotRequired[str]

class PullRequestReviewLinksHtml(TypedDict):
    href: str

class PullRequestReviewLinksPullRequest(TypedDict):
    href: str

class PullRequestReviewLinks(TypedDict):
    html: PullRequestReviewLinksHtml
    pull_request: PullRequestReviewLinksPullRequest

class PullRequestReview2(TypedDict):
    id: int
    node_id: str
    user: SimpleUser2 | None
    body: str
    state: str
    html_url: str
    pull_request_url: str
    _links: PullRequestReviewLinks
    submitted_at: NotRequired[str]
    commit_id: str
    body_html: NotRequired[str]
    body_text: NotRequired[str]
    author_association: Literal["COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "MEMBER", "NONE", "OWNER"]

class TagCommit(TypedDict):
    sha: str

class Tag(TypedDict):
    name: str
    commit: TagCommit

class IssueSearchResultItem(TypedDict):
    number: int
    title: str
    state: str
    html_url: str

class SearchIssuesAndPullRequestsResult(TypedDict):
    total_count: int
    items: list[IssueSearchResultItem]

def repos_get(*, owner: str, repo: str) -> FullRepository:
    """Get a repository's metadata (default branch, visibility, open issue count, topics).

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.

    Returns:
        A dict with full_name, description, default_branch, visibility, open_issues_count, stargazers_count, topics, html_url, pushed_at.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Example:
        github.repos_get(owner="octocat", repo="hello-world")"""

def issues_list_assignees(*, owner: str, repo: str, per_page: int = 30, page: int = 1) -> list[SimpleUser]:
    """List the users who are eligible to be assigned to issues in a specific repository.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has login.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.issues_list_assignees.pages(..., max_items=500) returns the items of every page (one call per page);
        github.issues_list_assignees.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.issues_list_assignees(owner="octocat", repo="hello-world")"""

def repos_list_branches(*, owner: str, repo: str, protected: bool | None = None, per_page: int = 30, page: int = 1) -> list[ShortBranch]:
    """List branch names and protection status in a repository.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        protected (bool): Setting to `true` returns only protected branches. When set to `false`, only unprotected branches are returned. Omittin…
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has name, protected.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.repos_list_branches.pages(..., max_items=500) returns the items of every page (one call per page);
        github.repos_list_branches.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.repos_list_branches(owner="octocat", repo="hello-world")"""

def repos_get_branch(*, owner: str, repo: str, branch: str) -> BranchWithProtection:
    """Get one branch with its latest commit.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        branch (str, required): The name of the branch.

    Returns:
        A dict with name, commit, _links, protected, protection, protection_url, pattern, required_approving_review_count.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Example:
        github.repos_get_branch(owner="octocat", repo="hello-world", branch="branch_1")"""

def repos_list_commits(*, owner: str, repo: str, sha: str | None = None, path: str | None = None, author: str | None = None, since: str | None = None, until: str | None = None, per_page: int = 30, page: int = 1) -> list[Commit2]:
    """List commits in a repository, newest first.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        sha (str): SHA or branch to start listing commits from. Default: the repository’s default branch (usually `master`).
        path (str): Only commits containing this file path will be returned.
        author (str): GitHub login or email address by which to filter by commit author.
        since (str, date-time): Only show notifications updated after the given time. This is a timestamp in [ISO 8601](https://en.wikipedia.org/wiki/I…
        until (str, date-time): Only commits before this date will be returned. This is a timestamp in [ISO 8601](https://en.wikipedia.org/wiki/ISO_860…
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has sha, commit.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.repos_list_commits.pages(..., max_items=500) returns the items of every page (one call per page);
        github.repos_list_commits.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.repos_list_commits(owner="octocat", repo="hello-world")"""

def issues_list_for_repo(*, owner: str, repo: str, milestone: str | None = None, state: Literal["open", "closed", "all"] = "open", assignee: str | None = None, creator: str | None = None, mentioned: str | None = None, labels: str | None = None, sort: Literal["created", "updated", "comments"] = "created", direction: Literal["asc", "desc"] = "desc", since: str | None = None, per_page: int = 30, page: int = 1) -> list[Issue]:
    """List issues (and pull requests, which GitHub returns through its issues API) in a repository.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        milestone (str): If an `integer` is passed, it should refer to a milestone by its `number` field. If the string `*` is passed, issues wi…
        state (Literal["open", "closed", "all"], default "open"): Which issues by state; open by default
        assignee (str): Can be the name of a user. Pass in `none` for issues with no assigned user, and `*` for issues assigned to any user.
        creator (str): The user that created the issue.
        mentioned (str): A user that's mentioned in the issue.
        labels (str): Comma-separated label names, e.g. bug,ui
        sort (Literal["created", "updated", "comments"], default "created"): What to sort results by.
        direction (Literal["asc", "desc"], default "desc"): The direction to sort the results by.
        since (str, date-time): Only issues updated at or after this ISO-8601 time
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has number, title, state, labels, comments, created_at, updated_at, html_url, pull_request, author.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.issues_list_for_repo.pages(..., max_items=500) returns the items of every page (one call per page);
        github.issues_list_for_repo.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.issues_list_for_repo(owner="octocat", repo="hello-world", labels="bug")"""

def issues_create(*, owner: str, repo: str, title: str | int, body: str | None = None, assignee: str | None = None, milestone: str | int | None = None, labels: list[str | IssuesCreateArgLabelsItem2] | None = None, assignees: list[str] | None = None) -> dict[str, Any]:
    """Create an issue.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        title (str | int, required): The title of the issue.
        body (str): The contents of the issue.
        assignee (str): Login for the user that this issue should be assigned to. _NOTE: Only users with push access can set the assignee for n…
        milestone (str | int)
        labels (list[str | IssuesCreateArgLabelsItem2]): Labels to associate with this issue. _NOTE: Only users with push access can set labels for new issues. Labels are silen…
        assignees (list[str]): Logins for Users to assign to this issue. _NOTE: Only users with push access can set assignees for new issues. Assignee…

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.issues_create(owner="octocat", repo="hello-world", title="Example")"""

def issues_list_comments_for_repo(*, owner: str, repo: str, sort: Literal["created", "updated"] = "created", direction: Literal["asc", "desc"] | None = None, since: str | None = None, per_page: int = 30, page: int = 1) -> list[IssueComment]:
    """List issue comments across a whole repository, for finding recent discussion.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        sort (Literal["created", "updated"], default "created"): The property to sort the results by. `created` means when the repository was starred. `updated` means when the reposito…
        direction (Literal["asc", "desc"]): Either `asc` or `desc`. Ignored without the `sort` parameter.
        since (str, date-time): Only show notifications updated after the given time. This is a timestamp in [ISO 8601](https://en.wikipedia.org/wiki/I…
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has id, user, body, created_at, issue_url.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.issues_list_comments_for_repo.pages(..., max_items=500) returns the items of every page (one call per page);
        github.issues_list_comments_for_repo.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.issues_list_comments_for_repo(owner="octocat", repo="hello-world")"""

def issues_get_comment(*, owner: str, repo: str, comment_id: int) -> IssueComment2:
    """Get one issue comment by its id.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        comment_id (int, required): The unique identifier of the comment.

    Returns:
        A dict with id, node_id, url, body, body_text, body_html, html_url, user, created_at, updated_at.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Example:
        github.issues_get_comment(owner="octocat", repo="hello-world", comment_id=1)"""

def issues_update_comment(*, owner: str, repo: str, comment_id: int, body: str) -> dict[str, Any]:
    """Replace the body of an issue comment.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        comment_id (int, required): The unique identifier of the comment.
        body (str, required): The contents of the comment.

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.issues_update_comment(owner="octocat", repo="hello-world", comment_id=1, body="example")"""

def issues_get(*, owner: str, repo: str, issue_number: int) -> Issue3:
    """Fetch an existing issue's details by its repository and issue number, including its title, body, labels, assignees, and state.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        issue_number (int, required): The number that identifies the issue.

    Returns:
        A dict with id, node_id, url, repository_url, labels_url, comments_url, events_url, html_url, number, state.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Example:
        github.issues_get(owner="octocat", repo="hello-world", issue_number=1)"""

def issues_update(*, owner: str, repo: str, issue_number: int, title: str | int | None = None, body: str | None = None, assignee: str | None = None, state: Literal["open", "closed"] | None = None, state_reason: Literal["completed", "not_planned", "reopened"] | None = None, milestone: str | int | None = None, labels: list[str | IssuesUpdateArgLabelsItem2] | None = None, assignees: list[str] | None = None) -> dict[str, Any]:
    """Update an issue's title, body, state (open/closed), labels, assignees or milestone.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        issue_number (int, required): The number that identifies the issue.
        title (str | int): The title of the issue.
        body (str): The contents of the issue.
        assignee (str): Login for the user that this issue should be assigned to. **This field is deprecated.**
        state (Literal["open", "closed"]): State of the issue. Either `open` or `closed`.
        state_reason (Literal["completed", "not_planned", "reopened"]): The reason for the current state
        milestone (str | int)
        labels (list[str | IssuesUpdateArgLabelsItem2]): Labels to associate with this issue. Pass one or more Labels to _replace_ the set of Labels on this Issue. Send an empt…
        assignees (list[str]): Logins for Users to assign to this issue. Pass one or more user logins to _replace_ the set of assignees on this Issue.…

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.issues_update(owner="octocat", repo="hello-world", issue_number=1)"""

def issues_add_assignees(*, owner: str, repo: str, issue_number: int, assignees: list[str] | None = None) -> dict[str, Any]:
    """Add assignees (logins) to an issue.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        issue_number (int, required): The number that identifies the issue.
        assignees (list[str]): Usernames of people to assign this issue to. _NOTE: Only users with push access can add assignees to an issue. Assignee…

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.issues_add_assignees(owner="octocat", repo="hello-world", issue_number=1)"""

def issues_list_comments(*, owner: str, repo: str, issue_number: int, since: str | None = None, per_page: int = 30, page: int = 1) -> list[IssueComment3]:
    """List the comments on one issue or pull request, oldest first.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        issue_number (int, required): The number that identifies the issue.
        since (str, date-time): Only show notifications updated after the given time. This is a timestamp in [ISO 8601](https://en.wikipedia.org/wiki/I…
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has id, body, created_at, html_url, author.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.issues_list_comments.pages(..., max_items=500) returns the items of every page (one call per page);
        github.issues_list_comments.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.issues_list_comments(owner="octocat", repo="hello-world", issue_number=1)"""

def issues_create_comment(*, owner: str, repo: str, issue_number: int, body: str) -> dict[str, Any]:
    """Add a comment to an issue or pull request (pull requests share issue numbers).

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        issue_number (int, required): The number that identifies the issue.
        body (str, required): The contents of the comment.

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.issues_create_comment(owner="octocat", repo="hello-world", issue_number=1, body="example")"""

def issues_list_labels_on_issue(*, owner: str, repo: str, issue_number: int, per_page: int = 30, page: int = 1) -> list[Label]:
    """List the labels on one issue.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        issue_number (int, required): The number that identifies the issue.
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has name.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.issues_list_labels_on_issue.pages(..., max_items=500) returns the items of every page (one call per page);
        github.issues_list_labels_on_issue.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.issues_list_labels_on_issue(owner="octocat", repo="hello-world", issue_number=1)"""

def issues_set_labels(*, owner: str, repo: str, issue_number: int, body: IssuesSetLabelsArgBody1 | list[str] | IssuesSetLabelsArgBody3 | list[IssuesSetLabelsArgBody4Item] | str | None = None) -> Any:
    """Replace all labels on an issue.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        issue_number (int, required): The number that identifies the issue.
        body (IssuesSetLabelsArgBody1 | list[str] | IssuesSetLabelsArgBody3 | list[IssuesSetLabelsArgBody4Item] | str)

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API."""

def issues_add_labels(*, owner: str, repo: str, issue_number: int, body: IssuesAddLabelsArgBody1 | list[str] | IssuesAddLabelsArgBody3 | list[IssuesAddLabelsArgBody4Item] | str | None = None) -> Any:
    """Add labels to an issue, keeping the existing ones.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        issue_number (int, required): The number that identifies the issue.
        body (IssuesAddLabelsArgBody1 | list[str] | IssuesAddLabelsArgBody3 | list[IssuesAddLabelsArgBody4Item] | str)

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.issues_add_labels(owner="octocat", repo="hello-world", issue_number=1)"""

def issues_remove_label(*, owner: str, repo: str, issue_number: int, name: str) -> Any:
    """Remove one label from an issue.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        issue_number (int, required): The number that identifies the issue.
        name (str, required)

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.
        ConfirmationRequired: not in the confirmed plan; ops.error(e)["plan"] says what it would change.

    Writes:
        Irreversible. run_script(mode="dry_run") plans it without calling the API; outside prod the run then needs the confirm token from that dry run.

    Example:
        github.issues_remove_label(owner="octocat", repo="hello-world", issue_number=1, name="label_1")"""

def issues_list_labels_for_repo(*, owner: str, repo: str, per_page: int = 30, page: int = 1) -> list[Label3]:
    """List the labels defined in a repository (use the names when labelling issues).

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has name, color, description.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.issues_list_labels_for_repo.pages(..., max_items=500) returns the items of every page (one call per page);
        github.issues_list_labels_for_repo.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.issues_list_labels_for_repo(owner="octocat", repo="hello-world")"""

def issues_create_label(*, owner: str, repo: str, name: str, color: str | None = None, description: str | None = None) -> dict[str, Any]:
    """Create a repository label with a name, a hex color (without

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        name (str, required): The name of the label. Emoji can be added to label names, using either native emoji or colon-style markup. For example,…
        color (str): The [hexadecimal color code](http://www.color-hex.com/) for the label, without the leading `#`.
        description (str): A short description of the label. Must be 100 characters or fewer.

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.issues_create_label(owner="octocat", repo="hello-world", name="label_1")"""

def issues_get_label(*, owner: str, repo: str, name: str) -> Label2:
    """Get one repository label by name.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        name (str, required)

    Returns:
        A dict with id, node_id, url, name, description, color, default.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Example:
        github.issues_get_label(owner="octocat", repo="hello-world", name="label_1")"""

def issues_list_milestones(*, owner: str, repo: str, state: Literal["open", "closed", "all"] = "open", sort: Literal["due_on", "completeness"] = "due_on", direction: Literal["asc", "desc"] = "asc", per_page: int = 30, page: int = 1) -> list[Milestone2]:
    """List milestones in a repository with their due dates and open/closed issue counts.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        state (Literal["open", "closed", "all"], default "open"): One of "open", "closed", "all", e.g. "all".
        sort (Literal["due_on", "completeness"], default "due_on"): What to sort results by. Either `due_on` or `completeness`.
        direction (Literal["asc", "desc"], default "asc"): The direction of the sort. Either `asc` or `desc`.
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has number, title, state, due_on, open_issues, closed_issues.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.issues_list_milestones.pages(..., max_items=500) returns the items of every page (one call per page);
        github.issues_list_milestones.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.issues_list_milestones(owner="octocat", repo="Hello-World", state="all")"""

def issues_create_milestone(*, owner: str, repo: str, title: str, state: Literal["open", "closed"] = "open", description: str | None = None, due_on: str | None = None) -> dict[str, Any]:
    """Create a milestone with a title and an optional ISO-8601 due date.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        title (str, required): The title of the milestone.
        state (Literal["open", "closed"], default "open"): The state of the milestone. Either `open` or `closed`.
        description (str): A description of the milestone.
        due_on (str, date-time): The milestone due date. This is a timestamp in [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) format: `YYYY-MM-DDTH…

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.issues_create_milestone(owner="octocat", repo="hello-world", title="Example")"""

def pulls_list(*, owner: str, repo: str, state: Literal["open", "closed", "all"] = "open", head: str | None = None, base: str | None = None, sort: Literal["created", "updated", "popularity", "long-running"] = "created", direction: Literal["asc", "desc"] | None = None, per_page: int = 30, page: int = 1) -> list[PullRequestSimple]:
    """List pull requests in a repository.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        state (Literal["open", "closed", "all"], default "open"): Either `open`, `closed`, or `all` to filter by state.
        head (str): Filter pulls by head user or head organization and branch name in the format of `user:ref-name` or `organization:ref-na…
        base (str): Filter pulls by base branch name. Example: `gh-pages`.
        sort (Literal["created", "updated", "popularity", "long-running"], default "created"): What to sort results by. `popularity` will sort by the number of comments. `long-running` will sort by date created and…
        direction (Literal["asc", "desc"]): The direction of the sort. Default: `desc` when sort is `created` or sort is not specified, otherwise `asc`.
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has number, title, state, draft, head, base, created_at, html_url, author.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.pulls_list.pages(..., max_items=500) returns the items of every page (one call per page);
        github.pulls_list.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.pulls_list(owner="octocat", repo="hello-world")"""

def pulls_create(*, owner: str, repo: str, head: str, base: str, title: str | None = None, body: str | None = None, maintainer_can_modify: bool | None = None, draft: bool | None = None, issue: int | None = None) -> dict[str, Any]:
    """Open a pull request from head (branch) into base (branch).

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        head (str, required): The name of the branch where your changes are implemented. For cross-repository pull requests in the same network, name…
        base (str, required): The name of the branch you want the changes pulled into. This should be an existing branch on the current repository. Y…
        title (str): The title of the new pull request. Required unless `issue` is specified.
        body (str): The contents of the pull request.
        maintainer_can_modify (bool): Indicates whether [maintainers can modify](https://docs.github.com/articles/allowing-changes-to-a-pull-request-branch-c…
        draft (bool): Indicates whether the pull request is a draft. See "[Draft Pull Requests](https://docs.github.com/en/articles/about-pul…
        issue (int): An issue in the repository to convert to a pull request. The issue title, body, and comments will become the title, bod…

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.pulls_create(owner="octocat", repo="hello-world", head="example", base="example")"""

def pulls_get(*, owner: str, repo: str, pull_number: int) -> PullRequest:
    """Get one pull request by number, including mergeability, head and base branches.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        pull_number (int, required): The number that identifies the pull request.

    Returns:
        A dict with url, id, node_id, html_url, diff_url, patch_url, issue_url, commits_url, review_comments_url, review_comment_url.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Example:
        github.pulls_get(owner="octocat", repo="hello-world", pull_number=1)"""

def pulls_update(*, owner: str, repo: str, pull_number: int, title: str | None = None, body: str | None = None, state: Literal["open", "closed"] | None = None, base: str | None = None, maintainer_can_modify: bool | None = None) -> dict[str, Any]:
    """Update a pull request's title, body, state or base branch.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        pull_number (int, required): The number that identifies the pull request.
        title (str): The title of the pull request.
        body (str): The contents of the pull request.
        state (Literal["open", "closed"]): State of this Pull Request. Either `open` or `closed`.
        base (str): The name of the branch you want your changes pulled into. This should be an existing branch on the current repository. …
        maintainer_can_modify (bool): Indicates whether [maintainers can modify](https://docs.github.com/articles/allowing-changes-to-a-pull-request-branch-c…

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.pulls_update(owner="octocat", repo="hello-world", pull_number=1)"""

def pulls_list_review_comments(*, owner: str, repo: str, pull_number: int, sort: Literal["created", "updated"] = "created", direction: Literal["asc", "desc"] | None = None, since: str | None = None, per_page: int = 30, page: int = 1) -> list[PullRequestReviewComment]:
    """List inline review comments on a pull request.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        pull_number (int, required): The number that identifies the pull request.
        sort (Literal["created", "updated"], default "created"): The property to sort the results by. `created` means when the repository was starred. `updated` means when the reposito…
        direction (Literal["asc", "desc"]): The direction to sort results. Ignored without `sort` parameter.
        since (str, date-time): Only show notifications updated after the given time. This is a timestamp in [ISO 8601](https://en.wikipedia.org/wiki/I…
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has id, user, body, path, line.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.pulls_list_review_comments.pages(..., max_items=500) returns the items of every page (one call per page);
        github.pulls_list_review_comments.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.pulls_list_review_comments(owner="octocat", repo="hello-world", pull_number=1)"""

def pulls_list_commits(*, owner: str, repo: str, pull_number: int, per_page: int = 30, page: int = 1) -> list[Commit3]:
    """List the commits in a pull request.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        pull_number (int, required): The number that identifies the pull request.
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has sha, commit.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.pulls_list_commits.pages(..., max_items=500) returns the items of every page (one call per page);
        github.pulls_list_commits.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.pulls_list_commits(owner="octocat", repo="hello-world", pull_number=1)"""

def pulls_list_files(*, owner: str, repo: str, pull_number: int, per_page: int = 30, page: int = 1) -> list[DiffEntry2]:
    """List the files changed in a pull request with additions and deletions.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        pull_number (int, required): The number that identifies the pull request.
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has filename, status, additions, deletions.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.pulls_list_files.pages(..., max_items=500) returns the items of every page (one call per page);
        github.pulls_list_files.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.pulls_list_files(owner="octocat", repo="hello-world", pull_number=1)"""

def pulls_check_if_merged(*, owner: str, repo: str, pull_number: int) -> Any:
    """Check whether a pull request has been merged.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        pull_number (int, required): The number that identifies the pull request.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Example:
        github.pulls_check_if_merged(owner="octocat", repo="hello-world", pull_number=1)"""

def pulls_merge(*, owner: str, repo: str, pull_number: int, body: PullsMergeArgBody | None = None) -> dict[str, Any]:
    """Merge a pull request.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        pull_number (int, required): The number that identifies the pull request.
        body (PullsMergeArgBody)

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.
        ConfirmationRequired: not in the confirmed plan; ops.error(e)["plan"] says what it would change.

    Writes:
        Irreversible. run_script(mode="dry_run") plans it without calling the API; outside prod the run then needs the confirm token from that dry run.

    Example:
        github.pulls_merge(owner="octocat", repo="hello-world", pull_number=1, body={"merge_method": "squash"})"""

def pulls_request_reviewers(*, owner: str, repo: str, pull_number: int, reviewers: list[str] | None = None, team_reviewers: list[str] | None = None) -> dict[str, Any]:
    """Request reviews from users (logins) or teams on a pull request.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        pull_number (int, required): The number that identifies the pull request.
        reviewers (list[str]): An array of user `login`s that will be requested.
        team_reviewers (list[str]): An array of team `slug`s that will be requested.

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.pulls_request_reviewers(owner="octocat", repo="hello-world", pull_number=1)"""

def pulls_list_reviews(*, owner: str, repo: str, pull_number: int, per_page: int = 30, page: int = 1) -> list[PullRequestReview]:
    """List the reviews on a pull request (approved, changes requested, commented).

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        pull_number (int, required): The number that identifies the pull request.
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has id, user, state, submitted_at.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.pulls_list_reviews.pages(..., max_items=500) returns the items of every page (one call per page);
        github.pulls_list_reviews.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.pulls_list_reviews(owner="octocat", repo="hello-world", pull_number=1)"""

def pulls_create_review(*, owner: str, repo: str, pull_number: int, commit_id: str | None = None, body: str | None = None, event: Literal["APPROVE", "REQUEST_CHANGES", "COMMENT"] | None = None, comments: list[PullsCreateReviewArgCommentsItem] | None = None) -> dict[str, Any]:
    """Submit a review on a pull request with event APPROVE, REQUEST_CHANGES or COMMENT.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        pull_number (int, required): The number that identifies the pull request.
        commit_id (str): The SHA of the commit that needs a review. Not using the latest commit SHA may render your review comment outdated if a…
        body (str): **Required** when using `REQUEST_CHANGES` or `COMMENT` for the `event` parameter. The body text of the pull request rev…
        event (Literal["APPROVE", "REQUEST_CHANGES", "COMMENT"]): The review action you want to perform. The review actions include: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`. By leavi…
        comments (list[PullsCreateReviewArgCommentsItem]): Use the following table to specify the location, destination, and contents of the draft review comment.

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        github.pulls_create_review(owner="octocat", repo="hello-world", pull_number=1)"""

def repos_list_tags(*, owner: str, repo: str, per_page: int = 30, page: int = 1) -> list[Tag]:
    """List tags in a repository.

    Args:
        owner (str, required): The account owner of the repository. The name is not case sensitive.
        repo (str, required): The name of the repository. The name is not case sensitive.
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A list; each item has name, commit.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.repos_list_tags.pages(..., max_items=500) returns the items of every page (one call per page);
        github.repos_list_tags.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.repos_list_tags(owner="octocat", repo="hello-world")"""

def search_issues_and_pull_requests(*, q: str, sort: Literal["comments", "reactions", "reactions-+1", "reactions--1", "reactions-smile", "reactions-thinking_face", "reactions-heart", "reactions-tada", "interactions", "created", "updated"] | None = None, order: Literal["desc", "asc"] = "desc", per_page: int = 30, page: int = 1) -> SearchIssuesAndPullRequestsResult:
    """Search issue and pull-request titles, bodies, and comments using keywords and GitHub qualifiers such as `repo:OWNER/REPO`.

    Args:
        q (str, required): The query contains one or more search keywords and qualifiers. Qualifiers allow you to limit your search to specific ar…
        sort (Literal["comments", "reactions", "reactions-+1", "reactions--1", "reactions-smile", "reactions-thinking_face", "reactions-heart", "reactions-tada", "interactions", "created", "updated"]): Sorts the results of your query by the number of `comments`, `reactions`, `reactions-+1`, `reactions--1`, `reactions-sm…
        order (Literal["desc", "asc"], default "desc"): Determines whether the first search result returned is the highest number of matches (`desc`) or lowest number of match…
        per_page (int, default 30): The number of results per page (max 100).
        page (int, default 1): Page number of the results to fetch.

    Returns:
        A dict with "items" (list) and total_count; each item has number, title, state, html_url.

    Raises:
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        github.search_issues_and_pull_requests.pages(..., max_items=500) returns the items of every page (one call per page);
        github.search_issues_and_pull_requests.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        github.search_issues_and_pull_requests(q="example")"""
