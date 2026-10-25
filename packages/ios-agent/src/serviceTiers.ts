/*
 * The launchd labels the slim service tier disables, and the services each feature needs.
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

import type { ServiceFeature, ServiceTier } from '@tapflowio/protocol'
import { LEAN_LABELS } from './leanLabels.js'

/**
 * simslim's full profile, minus three it never turns off and says why: `assistantd` (Spotlight's app leaks memory
 * without it), `gamed` and `sharingd`. Measured on an 8 GB Mac, booting with this list cut the boot's CPU
 * saturation from 20–49 s to 7–14 s against Lean mode's list (`contributing/simulator-boot-contention.md`).
 *
 * It turns off what Lean mode keeps on purpose — widgets and Live Activities, Spotlight, on-device models, push,
 * StoreKit and Wallet, photos, contacts, CloudKit, Sign in with Apple, App Attest — so it is only ever used when a
 * run asks for it, and `keep` puts back what that run's app needs.
 */
export const SLIM_LABELS: readonly string[] = [
  'com.apple.FamilyControlsAgent',
  'com.apple.GameController.gamecontrollerd',
  'com.apple.MapKit.SnapshotService',
  'com.apple.Maps.geocorrectiond',
  'com.apple.Maps.mapspushd',
  'com.apple.Maps.mapssyncd',
  'com.apple.PosterBoard',
  'com.apple.Safari.History',
  'com.apple.Safari.SafeBrowsing.Service',
  'com.apple.Safari.passwordbreachd',
  'com.apple.SafariBookmarksSyncAgent',
  'com.apple.ScreenTimeAgent',
  'com.apple.ScreenTimeSettingsAgent',
  'com.apple.SecureBackupDaemon',
  'com.apple.StatusKitAgent',
  'com.apple.TrustedPeersHelper',
  'com.apple.UsageTrackingAgent',
  'com.apple.WebBookmarks.webbookmarksd',
  'com.apple.activityawardsd',
  'com.apple.activitysharingd',
  'com.apple.akd',
  'com.apple.amsaccountsd',
  'com.apple.amsengagementd',
  'com.apple.amsondevicestoraged',
  'com.apple.announced',
  'com.apple.ap.adprivacyd',
  'com.apple.ap.promotedcontentd',
  'com.apple.appleaccountd',
  'com.apple.appleaccounttransparencyd',
  'com.apple.appleidsetupd',
  'com.apple.appstorecomponentsd',
  'com.apple.appstored',
  'com.apple.apsd',
  'com.apple.askpermissiond',
  'com.apple.asktod',
  'com.apple.assetsd',
  'com.apple.assetsd.nebulad',
  'com.apple.assetsubscriptiond',
  'com.apple.assistant_cdmd',
  'com.apple.assistant_service',
  'com.apple.avatarsd',
  'com.apple.bird',
  'com.apple.businessservicesd',
  'com.apple.calaccessd',
  'com.apple.carkitd',
  'com.apple.cdpd',
  'com.apple.chronod',
  'com.apple.ckdiscretionaryd',
  'com.apple.cloudd',
  'com.apple.cloudphotod',
  'com.apple.cloudsettingssyncagent',
  'com.apple.communicationtrustd',
  'com.apple.companiond',
  'com.apple.contacts.postersyncd',
  'com.apple.contactsd',
  'com.apple.coreidvd',
  'com.apple.corespeechd',
  'com.apple.corespotlightservice',
  'com.apple.countryd',
  'com.apple.dataaccess.dataaccessd',
  'com.apple.deviceaccessd',
  'com.apple.devicecheckd',
  'com.apple.diagnosticextensionsd',
  'com.apple.email.maild',
  'com.apple.exchangesyncd',
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
  'com.apple.gamesaved',
  'com.apple.generativeexperiencesd',
  'com.apple.geoanalyticsd',
  'com.apple.healthappd',
  'com.apple.healthcontentd',
  'com.apple.healthd',
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
  'com.apple.ind',
  'com.apple.intelligencecontextd',
  'com.apple.intelligenceflowd',
  'com.apple.intelligenceplatformd',
  'com.apple.intelligencetasksd',
  'com.apple.itunescloudd',
  'com.apple.itunesstored',
  'com.apple.jetpackassetd',
  'com.apple.knowledgeconstructiond',
  'com.apple.linkd',
  'com.apple.liveactivitiesd',
  'com.apple.managedconfiguration.passcodenagd',
  'com.apple.maps.destinationd',
  'com.apple.mediaanalysisd',
  'com.apple.mediaanalysisd.service',
  'com.apple.medialibraryd',
  'com.apple.mediastream.mstreamd',
  'com.apple.merchantd',
  'com.apple.mlhostd',
  'com.apple.mlruntimed',
  'com.apple.mobileassetd',
  'com.apple.modelcatalogd',
  'com.apple.modelmanagerd',
  'com.apple.musicd',
  'com.apple.naturallanguaged',
  'com.apple.navd',
  'com.apple.newsd',
  'com.apple.parsec-fbf',
  'com.apple.parsecd',
  'com.apple.passd',
  'com.apple.peopled',
  'com.apple.photoanalysisd',
  'com.apple.photosface',
  'com.apple.proactiveeventtrackerd',
  'com.apple.protectedcloudstorage.protectedcloudkeysyncing',
  'com.apple.purplebuddy.budd',
  'com.apple.rapportd',
  'com.apple.remindd',
  'com.apple.replicatord',
  'com.apple.rtcreportingd',
  'com.apple.safarifetcherd',
  'com.apple.searchd',
  'com.apple.searchtoold',
  'com.apple.securityuploadd',
  'com.apple.siri.acousticsignature',
  'com.apple.siri.context.service',
  'com.apple.siriactionsd',
  'com.apple.siriinferenced',
  'com.apple.siriknowledged',
  'com.apple.sirittsd',
  'com.apple.sociallayerd',
  'com.apple.sosd',
  'com.apple.speechmodeltrainingd',
  'com.apple.spotlightknowledged',
  'com.apple.spotlightknowledged.updater',
  'com.apple.stickersd',
  'com.apple.storagedatad',
  'com.apple.storekitd',
  'com.apple.suggestd',
  'com.apple.swcd',
  'com.apple.syncdefaultsd',
  'com.apple.telephonyutilities.callservicesd',
  'com.apple.textunderstandingd',
  'com.apple.tipsd',
  'com.apple.triald',
  'com.apple.tvremoted',
  'com.apple.videosubscriptionsd',
  'com.apple.voicebankingd',
  'com.apple.voiced',
  'com.apple.wcd',
  'com.apple.weatherd',
  'com.apple.webkit.adattributiond',
  'com.apple.webkit.webpushd',
  'com.apple.webprivacyd',
]

/**
 * The services each feature needs, from simslim's `features.go` (same commit). A feature is a user-facing
 * capability; its labels are what has to stay on for it to work. StoreKit needs Wallet and Finance too: products
 * load without them, but a purchase fails when the sheet is presented.
 */
export const FEATURE_LABELS: Record<ServiceFeature, readonly string[]> = {
  'push': ['com.apple.apsd'],
  'storekit': ['com.apple.storekitd', 'com.apple.itunesstored', 'com.apple.amsaccountsd', 'com.apple.amsengagementd', 'com.apple.amsondevicestoraged', 'com.apple.passd', 'com.apple.financed'],
  'app-store': ['com.apple.appstored', 'com.apple.itunesstored'],
  'universal-links': ['com.apple.swcd'],
  'spotlight': ['com.apple.searchd', 'com.apple.searchtoold'],
  'siri': ['com.apple.assistantd', 'com.apple.corespeechd'],
  'icloud': ['com.apple.cloudd'],
  'keychain-sync': ['com.apple.akd'],
  'contacts': ['com.apple.contactsd'],
  'calendar': ['com.apple.calaccessd'],
  'reminders': ['com.apple.remindd'],
  'mail': ['com.apple.email.maild'],
  'photos': ['com.apple.assetsd', 'com.apple.photoanalysisd'],
  'health': ['com.apple.healthd'],
  'homekit': ['com.apple.homed'],
  'imessage': ['com.apple.identityservicesd'],
  'widgets': ['com.apple.chronod', 'com.apple.liveactivitiesd'],
  // passd crashes at start-up without financed (leanLabels.ts), so keeping Wallet keeps both.
  'wallet': ['com.apple.passd', 'com.apple.financed'],
  'maps': ['com.apple.Maps.mapssyncd'],
  'weather': ['com.apple.weatherd'],
  'news': ['com.apple.newsd'],
  'game-center': ['com.apple.gamed'],
  'find-my': ['com.apple.findmy.findmylocated'],
  'screen-time': ['com.apple.ScreenTimeAgent'],
}

/** Every label any tier can switch off — what an unreadable marker is recovered against (`LeanStore`). */
export const MANAGED_LABELS: readonly string[] = [...new Set([...LEAN_LABELS, ...SLIM_LABELS])]

/**
 * The labels a tier switches off on a device: the tier's list, less every service a kept feature needs.
 * `stock` is the empty list, which is how "put everything back" is expressed to the store.
 */
export function labelsFor(tier: ServiceTier): readonly string[] {
  const base = tier.name === 'slim' ? SLIM_LABELS : tier.name === 'lean' ? LEAN_LABELS : []
  const kept = new Set(tier.keep.flatMap((f) => FEATURE_LABELS[f]))
  return base.filter((label) => !kept.has(label))
}
