import Component from '@glimmer/component';
import { tracked } from 'tracked-built-ins';
import { task } from 'ember-concurrency';
import { service } from '@ember/service';
import { waitForPromise } from '@ember/test-waiters';
import { action } from '@ember/object';
import type Store from 'ember-data/store';
import type IntlService from 'ember-intl/services/intl';

import ENUMS from 'irene/enums';
import parseError from 'irene/utils/parse-error';
import type { KnoxIqStatusCardState } from 'irene/components/knox-iq/status-card';
import type LoggerService from 'irene/services/logger';
import type MeService from 'irene/services/me';
import type FileModel from 'irene/models/file';
import type { FileDetailsAnalysesProviderContext } from './analyses-provider';
import type KnoxiqScanModel from 'irene/models/knoxiq-scan';

export type KnoxiqScanStatusByType = Record<number, number>;

interface KnoxiqStatusCardConfig {
  title?: string;
  subtitle?: string;
  state: KnoxIqStatusCardState;
}

interface KnoxiqStatusCardTemplate {
  titleKey?: string;
  subtitleKey?: string;
  state: KnoxIqStatusCardState;
}

const KNOXIQ_STATUS_CARDS = {
  running: {
    titleKey: 'knoxIq.statusCard.statusTitle',
    state: 'running',
  },
  completed: {
    titleKey: 'knoxIq.statusCard.statusTitle',
    state: 'completed',
  },
  ready: {
    titleKey: 'knoxIq.statusCard.readyTitle',
    subtitleKey: 'knoxIq.statusCard.readySubtitle',
    state: 'active',
  },
  'dast-ready': {
    titleKey: 'knoxIq.statusCard.readyTitle',
    subtitleKey: 'knoxIq.statusCard.dastReadySubtitle',
    state: 'active',
  },
  'dast-and-api-ready': {
    titleKey: 'knoxIq.statusCard.readyTitle',
    subtitleKey: 'knoxIq.statusCard.dastAndApiReadySubtitle',
    state: 'active',
  },
  'complete-dast': {
    titleKey: 'knoxIq.statusCard.completeDastTitle',
    subtitleKey: 'knoxIq.statusCard.completeDastSubtitle',
    state: 'inactive',
  },
  'complete-api': {
    titleKey: 'knoxIq.statusCard.completeApiTitle',
    subtitleKey: 'knoxIq.statusCard.completeApiSubtitle',
    state: 'inactive',
  },
  'api-ready': {
    titleKey: 'knoxIq.statusCard.readyTitle',
    subtitleKey: 'knoxIq.statusCard.apiReadySubtitle',
    state: 'active',
  },
  'api-scan-disabled': {
    titleKey: 'knoxIq.statusCard.apiScanDisabledTitle',
    subtitleKey: 'knoxIq.statusCard.apiScanDisabledSubtitle',
    state: 'inactive',
  },
  failed: {
    titleKey: 'knoxIq.statusCard.failedTitle',
    subtitleKey: 'knoxIq.statusCard.failedSubtitle',
    state: 'failed',
  },
} satisfies Record<string, KnoxiqStatusCardTemplate>;

export interface FileDetailsSignature {
  Args: {
    file: FileModel;
    fileAnalysesListContext: FileDetailsAnalysesProviderContext;
  };
}

export default class FileDetailsComponent extends Component<FileDetailsSignature> {
  @service declare store: Store;
  @service declare logger: LoggerService;
  @service declare me: MeService;
  @service declare intl: IntlService;
  @service('notifications') declare notify: NotificationService;

  @tracked knoxiqScan: KnoxiqScanModel | null = null;

  constructor(owner: unknown, args: FileDetailsSignature['Args']) {
    super(owner, args);

    if (this.canFetchKnoxiqData) {
      this.fetchKnoxiqFileScans.perform();
    }
  }

  /**
   * The file's own org's KnoxIQ setting — resolved from the file itself,
   * not the viewing user's org, since a superuser's own org has nothing
   * to do with whether this file's org has KnoxIQ on. Trigger-related UI
   * stays gated on this strict flag even for superusers; only viewing
   * already-produced results is bypassable (see `canFetchKnoxiqData`).
   *
   * Known limitation: for a file in an org the viewer doesn't belong to,
   * `project.organization` may not resolve (fetching another org's record
   * is scoped to the requester's own orgs), so this can read `false` even
   * when that org's flag is genuinely on. That only suppresses the
   * trigger-prompt UI for a not-yet-triggered cross-org file — a missing
   * affordance, not a security issue — and is out of scope for the
   * viewing-existing-results problem this fix targets.
   */
  get isKnoxiqEnabled() {
    if (this.args.file.isLegacyKnoxIQScan) {
      return false;
    }

    return Boolean(
      this.args.file.project?.get('organization')?.get('aiFeatures')?.knoxiq
    );
  }

  /**
   * Sub-feature of isKnoxiqEnabled — on by default, independently
   * toggleable off (mirrors mycroft's _trigger_scan gate). Only relevant
   * once isKnoxiqEnabled is already true, so the complete-api nudge checks
   * both rather than relying on this alone.
   */
  get isKnoxiqApiScanEnabled() {
    return Boolean(
      this.args.file.project?.get('organization')?.get('aiFeatures')
        ?.knoxiq_api_scan
    );
  }

  get isSuperuser() {
    return Boolean(this.me.org?.is_superuser);
  }

  /**
   * A superuser never gets KnoxIQ enabled for their own org, but may still
   * view KnoxIQ results on a client file. For them, rely on the file's own
   * backend-resolved is_knoxiq_enabled so we only hit the KnoxIQ endpoints
   * for files that actually have KnoxIQ on.
   */
  get canFetchKnoxiqData() {
    return (
      this.isKnoxiqEnabled ||
      (this.isSuperuser && Boolean(this.args.file.isKnoxiqEnabled))
    );
  }

  /**
   * Display-only KnoxIQ UI (scan card chips/accents). Unlike trigger UI,
   * this also shows for a superuser once the file's KnoxIQ status loads.
   */
  get showKnoxiqScanStatus() {
    return this.isKnoxiqEnabled || this.hasKnoxiqScanStatusLoaded;
  }

  get knoxiqScanRecord() {
    return this.knoxiqScan;
  }

  get knoxiqScanStatuses(): KnoxiqScanStatusByType {
    const record = this.knoxiqScanRecord;

    if (!record) {
      return {};
    }

    return {
      [ENUMS.KNOXIQ_SCAN_TYPE.SAST]: record.sastStatus,
      [ENUMS.KNOXIQ_SCAN_TYPE.DAST_MANUAL]: record.dastStatus,
      [ENUMS.KNOXIQ_SCAN_TYPE.API]: record.apiStatus,
    };
  }

  get hasKnoxiqScanStatusLoaded() {
    return (
      this.canFetchKnoxiqData &&
      this.fetchKnoxiqFileScans.isIdle &&
      this.knoxiqScanRecord != null
    );
  }

  get showKnoxiqFileDetails() {
    if (!this.hasKnoxiqScanStatusLoaded) {
      return false;
    }

    const { NOT_TRIGGERED, DISABLED } = ENUMS.KNOXIQ_SCAN_STATUS;

    return Object.values(this.knoxiqScanStatuses).some(
      (status) => status !== NOT_TRIGGERED && status !== DISABLED
    );
  }

  get hasAnyKnoxiqScanCompleted() {
    return Object.values(this.knoxiqScanStatuses).includes(
      ENUMS.KNOXIQ_SCAN_STATUS.COMPLETED
    );
  }

  /**
   * KnoxIQ being underway is enough to switch the table over. Rows it has not
   * scored yet show the untested flames and fill in as verdicts arrive.
   */
  get hasAnyKnoxiqScanStarted() {
    const { PENDING, RUNNING, COMPLETED } = ENUMS.KNOXIQ_SCAN_STATUS;

    return Object.values(this.knoxiqScanStatuses).some(
      (status) =>
        status === PENDING || status === RUNNING || status === COMPLETED
    );
  }

  get sastKnoxiqStatus() {
    return this.knoxiqScanRecord?.sastStatus;
  }

  get dastKnoxiqStatus() {
    return this.knoxiqScanRecord?.dastStatus;
  }

  get apiKnoxiqStatus() {
    return this.knoxiqScanRecord?.apiStatus;
  }

  get knoxiqStatusCardConfig(): KnoxiqStatusCardConfig | null {
    if (
      this.args.file.isKnoxiqAutomated ||
      !this.canFetchKnoxiqData ||
      !this.fetchKnoxiqFileScans.isIdle ||
      !this.hasKnoxiqScanStatusLoaded
    ) {
      return null;
    }

    const sastStatus = this.sastKnoxiqStatus;
    const dastStatus = this.dastKnoxiqStatus;
    const apiStatus = this.apiKnoxiqStatus;
    const {
      DISABLED,
      NOT_TRIGGERED,
      PENDING,
      RUNNING,
      COMPLETED,
      ERRORED,
      API_SCAN_DISABLED,
    } = ENUMS.KNOXIQ_SCAN_STATUS;

    if (
      sastStatus === ERRORED ||
      dastStatus === ERRORED ||
      apiStatus === ERRORED
    ) {
      return this.buildKnoxiqStatusCard(KNOXIQ_STATUS_CARDS.failed);
    }

    const isKnoxiqRunning = (status: number | undefined) =>
      status === RUNNING || status === PENDING;

    if (
      isKnoxiqRunning(sastStatus) ||
      isKnoxiqRunning(dastStatus) ||
      isKnoxiqRunning(apiStatus)
    ) {
      return this.buildKnoxiqStatusCard(KNOXIQ_STATUS_CARDS.running);
    }

    // API is an independent axis (sast/dast are mobile-only) — require it
    // settled too, when this file ever had one, before showing "completed".
    // Once the org's knoxiq_api_scan sub-toggle is on, "never ran an API
    // scan" no longer counts as settled either — that's exactly the gap
    // the complete-api nudge further below exists to fill, so "completed"
    // must not short-circuit past it.
    const isApiSettled = this.isKnoxiqApiScanEnabled
      ? apiStatus === COMPLETED
      : !this.args.file.isApiDone || apiStatus === COMPLETED;

    if (sastStatus === COMPLETED && dastStatus === COMPLETED && isApiSettled) {
      return this.buildKnoxiqStatusCard(KNOXIQ_STATUS_CARDS.completed);
    }

    // Everything below here prompts the viewer to trigger a scan, which
    // stays gated by the org's real flag -- a superuser viewing another
    // org's already-produced results must never see a "run KnoxIQ" CTA
    // the backend would reject.
    if (!this.isKnoxiqEnabled) {
      return null;
    }

    if (this.args.file.isStaticDone && sastStatus === NOT_TRIGGERED) {
      return this.buildKnoxiqStatusCard(KNOXIQ_STATUS_CARDS.ready);
    }

    const isDastDone =
      this.args.file.isManualDone || this.args.file.isDynamicDone;
    const isDastNotRun =
      dastStatus === NOT_TRIGGERED || dastStatus === DISABLED;
    const isDastKnoxiqReady =
      sastStatus === COMPLETED && isDastDone && isDastNotRun;
    const isApiKnoxiqReady =
      this.args.file.isApiDone &&
      (apiStatus === NOT_TRIGGERED || apiStatus === DISABLED);

    // Checked ahead of the single-type dast-ready/api-ready branches below:
    // when both scan types are simultaneously waiting on KnoxIQ, "Run
    // KnoxIQ" triggers both together (file.triggerKnoxiqScan() isn't scoped
    // to one type), so the card must say so instead of naming only DAST.
    if (isDastKnoxiqReady && isApiKnoxiqReady) {
      return this.buildKnoxiqStatusCard(
        KNOXIQ_STATUS_CARDS['dast-and-api-ready']
      );
    }

    if (isDastKnoxiqReady) {
      return this.buildKnoxiqStatusCard(KNOXIQ_STATUS_CARDS['dast-ready']);
    }

    // Distinct from the NOT_TRIGGERED/DISABLED "ready to trigger" branch
    // below: this file will never be auto-triggered for API scan — the org
    // turned the sub-feature off — so it must not get the "ready"/actionable
    // messaging. Same priority as that branch, for the same reason (API is
    // the most current signal, ahead of the DAST-incomplete fallback).
    if (this.args.file.isApiDone && apiStatus === API_SCAN_DISABLED) {
      return this.buildKnoxiqStatusCard(
        KNOXIQ_STATUS_CARDS['api-scan-disabled']
      );
    }

    // Checked ahead of the DAST-incomplete fallback below so a file that's
    // ready for API validation always gets an actionable (enabled) card,
    // even while DAST is still the thing nominally "blocking" otherwise.
    if (isApiKnoxiqReady) {
      const hasAnyKnoxiqRunCompleted =
        sastStatus === COMPLETED || dastStatus === COMPLETED;

      return this.buildKnoxiqStatusCard(
        hasAnyKnoxiqRunCompleted
          ? KNOXIQ_STATUS_CARDS['api-ready']
          : KNOXIQ_STATUS_CARDS.ready
      );
    }

    if (sastStatus === COMPLETED && isDastNotRun) {
      return this.buildKnoxiqStatusCard(KNOXIQ_STATUS_CARDS['complete-dast']);
    }

    // Mirrors complete-dast above: nudge toward the API scan itself once
    // it's the only thing left blocking KnoxIQ, reached only once DAST no
    // longer needs its own nudge (checked first, same priority tier) so a
    // file that still needs both keeps showing the DAST prompt first.
    // Gated on the knoxiq_api_scan sub-toggle — unlike DAST, API scan can be
    // turned off independently of KnoxIQ itself, and this file may simply
    // never run one.
    //
    // Known gap: this only checks whether an API scan has EVER completed
    // (isApiDone), not whether KnoxIQ has run for the file's *latest* API
    // scan specifically. A file that re-runs its API scan after KnoxIQ
    // already completed for an earlier run won't get re-nudged until the
    // backend exposes a scan-id to compare against (tracked separately).
    if (
      sastStatus === COMPLETED &&
      this.isKnoxiqApiScanEnabled &&
      !this.args.file.isApiDone
    ) {
      return this.buildKnoxiqStatusCard(KNOXIQ_STATUS_CARDS['complete-api']);
    }

    return null;
  }

  @action buildKnoxiqStatusCard(
    template: KnoxiqStatusCardTemplate
  ): KnoxiqStatusCardConfig {
    return {
      title: template.titleKey ? this.intl.t(template.titleKey) : undefined,
      subtitle: template.subtitleKey
        ? this.intl.t(template.subtitleKey)
        : undefined,
      state: template.state,
    };
  }

  @action
  runKnoxiqScan() {
    this.triggerKnoxiqScan.perform();
  }

  triggerKnoxiqScan = task(async () => {
    try {
      await waitForPromise(this.args.file.triggerKnoxiqScan());
    } catch (error) {
      this.notify.error(parseError(error));
    }
  });

  fetchKnoxiqFileScans = task(async () => {
    if (!this.canFetchKnoxiqData) {
      return;
    }

    try {
      this.knoxiqScan = await waitForPromise(
        this.store.queryRecord('knoxiq-scan', {
          id: this.args.file.id,
          fileId: this.args.file.id,
        })
      );
    } catch (error) {
      // A superuser probing another org's file that has no KnoxIQ history
      // yet is expected to be denied here -- fail quietly instead of
      // toasting an error for what is really just "nothing to show".
      const isExpectedDenial =
        this.isSuperuser &&
        !this.isKnoxiqEnabled &&
        (error as { errors?: { status?: string }[] })?.errors?.[0]?.status ===
          '403';

      if (isExpectedDenial) {
        return;
      }

      this.notify.error(parseError(error));
    }
  });
}

declare module '@glint/environment-ember-loose/registry' {
  export default interface Registry {
    FileDetails: typeof FileDetailsComponent;
  }
}
