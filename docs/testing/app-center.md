---
title: App Center
description: "The dashboard's build list, grouped by app and version: uploading builds, search and status filter, review status, scheduled deletion, and starting a QA Session."
---

<a id="uploading-builds"></a>

# App Center

App Center is the build list inside the tapflow dashboard. It has nothing to do with Microsoft App Center. The iOS and Android builds your team uploads collect here by app and version, and this is where you pick one and start a QA Session. It is the first screen you see after signing in.

## How to use {#how-to-use}

1. Pick an app from the **Apps** list on the left. An app is identified by its bundle ID (the iOS bundle identifier or the Android package name) and platform.
2. Builds are grouped by version name into collapsible releases. A build whose version name could not be read goes under **Unversioned**.
3. Press **Start QA** on the build you want to test. The build's [QA Session](/testing/qa-session) opens.

Each build row shows the build number, platform, review status badge, scheduled-deletion badge, uploader, and upload date.

### Find a build {#find-a-build}

- Type part of a version name into **Search version…** to see only builds whose version contains it.
- Pick **Backlog**, **In Progress**, **Done** or **Rejected** in the status filter (default **All statuses**) to see only builds with that status.

When nothing matches, the list shows **No matching builds**.

## Upload a build {#upload-a-build}

<a id="dashboard-upload"></a>

1. Press **Upload build** at the top right of the screen.
2. Click the **File** area to choose a file, or drag one onto it.
   - iOS: a simulator build, `.app.zip` or `.tar.gz`/`.tgz`. A `.app.zip` is the `.app` folder [built from the command line](https://developer.apple.com/library/archive/technotes/tn2339/_index.html) and zipped. Upload a cloud simulator build's `.tar.gz`/`.tgz`, such as one from EAS, as it is.
   - Android: `.apk`
3. Optionally pick a review status under **Status (optional)**. With the default, **None**, the build has no status.
4. Press **Upload**. A **Build uploaded** notice appears and the build joins the list.

::: warning iOS `.ipa` files are not supported
`.ipa` is the format for real devices. tapflow accepts `.app.zip` and `.tar.gz`/`.tgz` for simulators. If an upload fails, see [Builds & uploads troubleshooting](/troubleshooting/builds#ios-build-upload-errors).
:::

An uploaded build is linked to an app by its bundle ID. If no app has that bundle ID, a new one is created. Uploading while an app is selected links the build to that app. If the build's bundle ID differs from the selected app's, it goes to the app for its own bundle ID instead.

You can also create the app first with **Add App** below the **Apps** list, giving its **Name**, **Bundle ID** and **Platform** (iOS, Android or Both).

To upload builds automatically from a CI pipeline, see [Upload from CI](/operate/ci-distribution).

## Review status {#review-status}

The review status tells the team how far a build has been checked. Change it from the status menu on the build's row.

| Status | Meaning |
|---|---|
| — | No status |
| **Backlog** | Not yet ready |
| **In Progress** | Ready for review |
| **Done** | Stakeholders approved |
| **Rejected** | Issues found, needs fixes |

- A build marked **Done** has its **Start QA** button disabled. To test an approved build again, change its status first.
- In a QA Session, the status badge sits next to the breadcrumb at the top until you pick a Mac.
- When the status changes to **Done** or **Rejected**, any [review webhooks](/operate/webhooks) your operator registered are called.

## Schedule deletion {#schedule-deletion}

Schedule a build you no longer need for deletion with the trash icon (**Schedule deletion**). Press **Schedule deletion** in the confirmation and the build files are deleted after 7 days. The row gets a countdown badge such as **Deletes in 6d**.

Until then you can cancel it any time with the timer icon (**Cancel scheduled deletion**). Scheduled deletion is independent of the review status.

## Platform support {#platform-support}

| | iOS | Android |
|---|---|---|
| Upload file | `.app.zip`, `.tar.gz`/`.tgz` (simulator build) | `.apk` |
| What identifies the app | Bundle identifier | Package name |

## Limits {#limits}

- The Viewer role is read-only. When a Viewer presses **Upload build** or **Add App**, a notice says QA or Developer access is needed instead of opening the dialog. A Viewer sees no status menu and no deletion button, only **Start QA** and the status badge. For what each role can do, see [Team, roles & tokens](/operate/team-and-roles#team).
- The list shows each app's 100 most recently uploaded builds. Search by version to find older ones.
- App Center cannot rename or delete an app. The Admin, Developer and QA roles can do both from the **Apps** card in **Settings → Default**. Deleting an app deletes all of its builds.
- The deletion confirmation always says 7 days. If your operator changed `TAPFLOW_BUILD_TTL_DAYS` on the relay, the real period follows that value.

## Troubleshooting {#troubleshooting}

- If an upload fails with a `400` error, see [iOS build upload errors](/troubleshooting/builds#ios-build-upload-errors).
- If an APK shows as **Unversioned** or merges into another app, see [Builds & uploads](/troubleshooting/builds).

## Related {#related}

- [QA Session](/testing/qa-session): picking a Mac and a device after pressing **Start QA**
- [Upload from CI](/operate/ci-distribution): uploading builds automatically from a pipeline
- [Review webhooks](/operate/webhooks): notifying another system when a review status changes
