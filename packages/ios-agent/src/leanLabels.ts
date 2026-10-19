/*
 * The launchd labels Lean mode disables on an iOS simulator.
 *
 * Selected from simslim (https://github.com/MobAI-App/simslim, commit e752a728), which is:
 *
 *   MIT License
 *
 *   Copyright (c) 2026 Interlap
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

/**
 * Background services apps rarely ask for, selected label by label from simslim's categories —
 * and **not** simslim's default, which disables everything and leaves keeping things to the user.
 *
 * Disabled: Siri itself and Apple Intelligence indexing; iCloud Keychain and backup; store extras;
 * the Health app, fitness and HomeKit; photo analysis; Family Sharing and Screen Time; News, Maps
 * sync and Tips; iMessage and FaceTime; AirDrop, Continuity, CarPlay, Watch, Find My, stickers and
 * avatars; Safari bookmark, reading-list and password-breach sync; Business Chat, ID verification
 * and the passcode nag; telemetry.
 *
 * **Kept on purpose**, because an app under test or a tester's eye depends on it:
 * - on screen: the wallpaper (PosterBoard) and widgets / Live Activities (chronod, liveactivitiesd).
 *   They are also most of what simslim saves (675 MB of its measured total), so keeping them is the
 *   single biggest cost of this list — measured about −25% per device instead of −50%.
 * - behind frameworks apps call: dictation, speech and keyboard suggestions; on-device models;
 *   Sign in with Apple, CloudKit, iCloud Drive and key-value storage; StoreKit, push, Wallet and
 *   Apple Pay; HealthKit; the photo picker and media library; DeviceCheck / App Attest;
 *   FamilyControls and DeviceActivity; WeatherKit, MapKit snapshots, Game Center and game
 *   controllers; CallKit; App Intents; asset downloads; Focus status.
 * - whole categories: contacts and calendars, Spotlight and Settings search, and web services
 *   including universal links (swcd).
 *
 * `com.apple.siri.context.service` is in simslim's list and not here: it is not a launchd daemon,
 * so the override store cannot stop it — measured still running with its override set.
 *
 * None of tapflow's own paths (streaming, input, the XCUITest tree, the pasteboard, audio,
 * installs, deep links, the network layers) runs through any of these.
 */
export const LEAN_LABELS: readonly string[] = [
  'com.apple.Maps.geocorrectiond',
  'com.apple.Maps.mapspushd',
  'com.apple.Maps.mapssyncd',
  'com.apple.Safari.passwordbreachd',
  'com.apple.SafariBookmarksSyncAgent',
  'com.apple.ScreenTimeAgent',
  'com.apple.ScreenTimeSettingsAgent',
  'com.apple.SecureBackupDaemon',
  'com.apple.TrustedPeersHelper',
  'com.apple.WebBookmarks.webbookmarksd',
  'com.apple.activityawardsd',
  'com.apple.activitysharingd',
  'com.apple.announced',
  'com.apple.ap.adprivacyd',
  'com.apple.ap.promotedcontentd',
  'com.apple.appleaccounttransparencyd',
  'com.apple.appleidsetupd',
  'com.apple.appstorecomponentsd',
  'com.apple.askpermissiond',
  'com.apple.asktod',
  'com.apple.assetsubscriptiond',
  'com.apple.assistant_cdmd',
  'com.apple.assistant_service',
  'com.apple.assistantd',
  'com.apple.avatarsd',
  'com.apple.businessservicesd',
  'com.apple.carkitd',
  'com.apple.cdpd',
  'com.apple.cloudphotod',
  'com.apple.cloudsettingssyncagent',
  'com.apple.communicationtrustd',
  'com.apple.companiond',
  'com.apple.coreidvd',
  'com.apple.diagnosticextensionsd',
  'com.apple.facetimemessagestored',
  'com.apple.familycircled',
  'com.apple.familynotification',
  'com.apple.feedbackd',
  'com.apple.financed',
  'com.apple.findmy.findmylocated',
  'com.apple.finhealthd',
  'com.apple.fitcore',
  'com.apple.fitcore.session',
  'com.apple.fitnesscoachingd',
  'com.apple.fitnessintelligenced',
  'com.apple.followupd',
  'com.apple.geoanalyticsd',
  'com.apple.healthappd',
  'com.apple.healthcontentd',
  'com.apple.healtheventsd',
  'com.apple.healthrecordsd',
  'com.apple.homed',
  'com.apple.homeeventsd',
  'com.apple.icloudmailagent',
  'com.apple.icloudsubscriptionoptimizerd',
  'com.apple.identityservicesd',
  'com.apple.ids_simd',
  'com.apple.imautomatichistorydeletionagent',
  'com.apple.imcore.imtransferagent',
  'com.apple.imdpersistence.IMDPersistenceAgent',
  'com.apple.intelligencecontextd',
  'com.apple.intelligenceflowd',
  'com.apple.intelligenceplatformd',
  'com.apple.intelligencetasksd',
  'com.apple.itunescloudd',
  'com.apple.knowledgeconstructiond',
  'com.apple.managedconfiguration.passcodenagd',
  'com.apple.maps.destinationd',
  'com.apple.mediaanalysisd',
  'com.apple.mediaanalysisd.service',
  'com.apple.mediastream.mstreamd',
  'com.apple.musicd',
  'com.apple.navd',
  'com.apple.newsd',
  'com.apple.parsec-fbf',
  'com.apple.parsecd',
  'com.apple.photoanalysisd',
  'com.apple.photosface',
  'com.apple.proactiveeventtrackerd',
  'com.apple.protectedcloudstorage.protectedcloudkeysyncing',
  'com.apple.purplebuddy.budd',
  'com.apple.rapportd',
  'com.apple.rtcreportingd',
  'com.apple.safarifetcherd',
  'com.apple.securityuploadd',
  'com.apple.siri.acousticsignature',
  'com.apple.siriactionsd',
  'com.apple.siriinferenced',
  'com.apple.siriknowledged',
  'com.apple.sociallayerd',
  'com.apple.sosd',
  'com.apple.speechmodeltrainingd',
  'com.apple.stickersd',
  'com.apple.tipsd',
  'com.apple.triald',
  'com.apple.tvremoted',
  'com.apple.videosubscriptionsd',
  'com.apple.voicebankingd',
  'com.apple.wcd',
]
