import React, { PureComponent } from 'react';
import {
  FieldDisplay,
  fieldReducers,
  getFieldDisplayValues,
  GetFieldDisplayValuesOptions,
  PanelProps,
  DataHoverEvent,
  DataHoverPayload,
  DataHoverClearEvent,
} from '@grafana/data';
import { config, getTemplateSrv, getLocationSrv, locationService } from '@grafana/runtime';
import { Subscription, throttleTime } from 'rxjs';
import { OptionsInterface, CalcsMutation, ErrorObj, HTMLNodeElement } from 'types';
import 'fonts.scss';
import { parseJSON } from 'utils/parseJSON';
import _ from 'lodash';
import { Errors } from 'components/Errors';
import { addShadowRoot } from 'utils/addShadowRoot';
import { triggerPanelupdate } from 'utils/events/panelupdate';
import { triggerPanelwillunmount } from 'utils/events/panelwillunmount';

import { addHtml } from 'utils/addHtml';
import { CustomScrollbar } from '@grafana/ui';

interface Props extends PanelProps<OptionsInterface> {}
interface PanelState {
  shadowContainerRef: React.RefObject<HTMLDivElement>;
  errors: { [key: string]: string };
  options: OptionsInterface;
}

interface PopulatedGetFieldDisplayValuesOptions {
  series?: GetFieldDisplayValuesOptions['data'];
  reduceOptions?: GetFieldDisplayValuesOptions['reduceOptions'];
  fieldConfig?: GetFieldDisplayValuesOptions['fieldConfig'];
  replaceVariables?: GetFieldDisplayValuesOptions['replaceVariables'];
  sparkline?: GetFieldDisplayValuesOptions['sparkline'];
  theme?: GetFieldDisplayValuesOptions['theme'];
  timeZone?: GetFieldDisplayValuesOptions['timeZone'];
}

export class HTMLPanel extends PureComponent<Props, PanelState> {
  state: PanelState = {
    shadowContainerRef: React.createRef<HTMLDivElement>(),
    errors: {},
    options: { ...this.props.options },
  };

  errors: PanelState['errors'] = {};
  defaultErrorMessage = 'Check console for more info (ctrl+shift+j)';
  data = this.props.data; // Used for dynamic data
  dynamicProps = this.props; // Used for dynamic props
  fieldDisplayValues: FieldDisplay[] = [];
  panelSize = { height: this.props.height, width: this.props.width };
  shadowElt: HTMLDivElement | null = null;
  htmlGraphics: ReturnType<typeof this.getHtmlGraphics> | null = null;

  // For hover handling
  latestHoverPayload: DataHoverPayload | null = null;
  isActivelyHovering = false; // New flag to track if hover is active
  clickListener: ((e: MouseEvent) => void) | null = null;
  dataHoverSubscription?: Subscription;
  dataHoverClearSubscription?: Subscription;
  // For debounce protection
  hoverClearTimerId?: number;
  hoverClearDelay = 250; // ms delay after hover clear before

  getHtmlGraphics({ dynamicData = false, dynamicFieldDisplayValues = false, dynamicProps = false } = {}) {
    const data = dynamicData ? this.data : { ...this.props.data };
    const props = dynamicProps ? this.dynamicProps : { ...this.props };
    const fieldDisplayValues = dynamicFieldDisplayValues ? this.fieldDisplayValues : { ...this.fieldDisplayValues };
    const htmlNode = this.state.shadowContainerRef.current?.firstElementChild?.shadowRoot as HTMLNodeElement;
    const codeData = this.getCodeData();
    const { options, width, height } = this.props;
    // eslint-disable-next-line deprecation/deprecation
    const { theme, theme2 } = config;

    return {
      htmlNode,
      data,
      customProperties: codeData,
      codeData,
      options,
      theme,
      theme2,
      getTemplateSrv,
      getLocationSrv,
      locationService,
      props,
      width,
      height,
      getFieldDisplayValues: this.populatedGetFieldDisplayValues,
      fieldDisplayValues,
      fieldReducers,
    };
  }

  populatedGetFieldDisplayValues = ({
    series = this.props.data.series,
    fieldConfig = this.props.fieldConfig,
    reduceOptions = this.props.options.reduceOptions,
    replaceVariables = this.props.replaceVariables,
    theme = config.theme2,
    sparkline,
    timeZone,
  }: PopulatedGetFieldDisplayValuesOptions = {}) =>
    getFieldDisplayValues({
      data: series,
      fieldConfig,
      reduceOptions,
      replaceVariables,
      theme,
      sparkline,
      timeZone,
    });

  onInitOnResize() {
    if (
      this.props.options.onInitOnResize &&
      !(this.panelSize.height === this.props.height && this.panelSize.width === this.props.width)
    ) {
      this.onInit();

      this.panelSize.height = this.props.height;
      this.panelSize.width = this.props.width;
    }
  }

  updateFieldDisplayValues = () => {
    const { calcsMutation } = this.props.options;

    if (calcsMutation !== CalcsMutation.None) {
      this.fieldDisplayValues.splice(0, this.fieldDisplayValues.length);
      this.fieldDisplayValues.push(...this.populatedGetFieldDisplayValues());
    } else {
      this.fieldDisplayValues.splice(0, this.fieldDisplayValues.length);
    }
  };

  updateDynamicReferences = () => {
    const { dynamicData, dynamicFieldDisplayValues, dynamicProps, dynamicHtmlGraphics } = this.props.options;

    // Update this.data with the new data
    if (dynamicData) {
      Object.assign(this.data, this.props.data);
    }

    if (dynamicProps) {
      Object.assign(this.dynamicProps, this.props);
    }

    if (dynamicHtmlGraphics && this.htmlGraphics) {
      Object.assign(this.htmlGraphics, this.getHtmlGraphics({ dynamicData, dynamicFieldDisplayValues, dynamicProps }));
    }
  };

  getCodeData() {
    const {
      json: codeData,
      isError,
      error,
    } = parseJSON(this.props.options.codeData, {
      namespace: 'codeData',
    });

    this.updateError({
      scope: 'codeData',
      isError,
      error,
    });

    return codeData ?? {};
  }

  executeScript(
    script: string,
    { dynamicData = false, dynamicFieldDisplayValues = false, dynamicProps = false, dynamicHtmlGraphics = false } = {}
  ) {
    const rawHtmlGraphics = this.getHtmlGraphics({ dynamicData, dynamicFieldDisplayValues, dynamicProps });
    const { htmlNode, data, codeData, options, theme } = rawHtmlGraphics;

    if (dynamicHtmlGraphics) {
      this.htmlGraphics = rawHtmlGraphics;
    }

    const htmlGraphics = dynamicHtmlGraphics ? this.htmlGraphics : rawHtmlGraphics;

    const F = new Function(
      'htmlNode',
      'data',
      'customProperties',
      'codeData',
      'options',
      'theme',
      'getTemplateSrv',
      'getLocationSrv',
      'htmlGraphics',
      script
    );
    // eslint-disable-next-line deprecation/deprecation
    F(htmlNode, data, codeData, codeData, options, theme, getTemplateSrv, getLocationSrv, htmlGraphics);
  }

  onRender() {
    const errorObj: ErrorObj = {
      scope: 'onRender',
      isError: false,
    };

    const { onRender } = this.props.options;

    if (onRender) {
      try {
        this.executeScript(onRender);
      } catch (e) {
        errorObj.isError = true;
        errorObj.error = e;
        console.error(`onRender:`, e);
      }
    }

    this.updateError(errorObj);
  }

  onInit() {
    const errorObj: ErrorObj = {
      scope: 'onInit',
      isError: false,
    };

    const { onInit, dynamicData, dynamicFieldDisplayValues, dynamicProps, dynamicHtmlGraphics } = this.props.options;

    if (onInit) {
      try {
        this.executeScript(onInit, { dynamicData, dynamicFieldDisplayValues, dynamicProps, dynamicHtmlGraphics });
      } catch (e) {
        errorObj.isError = true;
        errorObj.error = e;
        console.error(`onInit:`, e);
      }
    }

    this.updateError(errorObj);
  }

  initialize() {
    this.shadowElt = addShadowRoot(this.state.shadowContainerRef.current, {
      centerAlignContent: this.props.options.centerAlignContent,
    });

    this.updateError(addHtml(this.state.shadowContainerRef.current, this.props.options));
    this.onInit();
  }
  componentDidMount() {
    this.updateFieldDisplayValues();
    this.initialize();

    if (this.props.options.renderOnMount) {
      this.onRender();
    }

    if (this.props.options.panelupdateOnMount) {
      triggerPanelupdate(this.shadowElt);
    }

    // Set up click listener
    this.clickListener = this.handleClick.bind(this);
    window.addEventListener('click', this.clickListener);

    // Set up data hover subscriptions
    if (this.props.eventBus) {
      // Subscribe to hover events
      this.dataHoverSubscription = this.props.eventBus
        .getStream(DataHoverEvent)
        .pipe(throttleTime(50))
        .subscribe((event) => {
          // Log the hover event but don't store the payload
          if (this.hoverClearTimerId === undefined) {
            this.isActivelyHovering = true;
            this.latestHoverPayload = event.payload;
            console.error('Hover detected, payload stored:', this.latestHoverPayload);
          } else {
            console.error('Hover not yet cleared, ignoring new hover event');
          }
        });

      // Subscribe to hover clear events
      this.dataHoverClearSubscription = this.props.eventBus
        .getStream(DataHoverClearEvent)
        .pipe(throttleTime(50))
        .subscribe(() => {
          console.error('Hover clear event received');

          // Immediately mark as not hovering
          this.isActivelyHovering = false;

          // Set a timer to ensure full reset before new hover actions
          this.hoverClearTimerId = window.setTimeout(() => {
            console.error('Hover state fully reset after delay');
            // We could optionally clear the payload here too:
            // this.latestHoverPayload = null;
            this.hoverClearTimerId = undefined;
          }, this.hoverClearDelay);
        });
    }

    // EXTENSIVE EVENT BUS DEBUGGING
    console.error('DEBUGGING: Component mounted, examining event bus');
    console.error('Event bus available:', !!this.props.eventBus);
    console.error('Event bus object:', this.props.eventBus);

    if (!_.isEqual(this.state.errors, this.errors)) {
      this.setState({ errors: { ...this.errors } });
    }
  }

  componentDidUpdate() {
    this.updateFieldDisplayValues();
    this.updateDynamicReferences();

    const isChanged = !_.isEqual(this.state.options, this.props.options);

    if (isChanged) {
      this.initialize();
      this.setState({ options: { ...this.props.options } });
    } else {
      this.onInitOnResize();
      triggerPanelupdate(this.shadowElt);
      this.onRender();

      if (!_.isEqual(this.state.errors, this.errors)) {
        this.setState({ errors: { ...this.errors } });
      }
    }
  }

  componentWillUnmount() {
    triggerPanelwillunmount(this.shadowElt);

    // Clean up event listeners
    if (this.clickListener) {
      window.removeEventListener('click', this.clickListener);
    }

    // Clean up hover clear timer if active
    if (this.hoverClearTimerId !== undefined) {
      window.clearTimeout(this.hoverClearTimerId);
      this.hoverClearTimerId = undefined;
    }

    // Clean up subscriptions
    if (this.dataHoverSubscription) {
      this.dataHoverSubscription.unsubscribe();
    }

    if (this.dataHoverClearSubscription) {
      this.dataHoverClearSubscription.unsubscribe();
    }
  }

  // Handle click events to execute onDataHover if ALT is pressed AND actively hovering
  handleClick(e: MouseEvent) {
    if (e.altKey && this.isActivelyHovering && this.latestHoverPayload && this.props.options.onDataHover) {
      console.error(
        'ALT + click detected while hovering, executing onDataHover with payload:',
        this.latestHoverPayload
      );
      this.executeDataHoverScript(this.latestHoverPayload);

      // Prevent default browser behavior for ALT+click
      e.preventDefault();
    }
  }

  updateError({ scope, isError, error }: ErrorObj) {
    if (!isError && this.state.errors[scope]) {
      delete this.errors[scope];
    } else {
      const errorMessage = error instanceof Error ? error.message : this.defaultErrorMessage;
      if (isError && this.errors[scope] !== errorMessage) {
        this.errors = { ...this.errors, [scope]: errorMessage };
      }
    }
  }

  render() {
    const {
      width,
      height,
      options: { useGrafanaScrollbar, overflow },
    } = this.props;

    return (
      <>
        <div style={{ position: 'absolute', width: `${width}px`, height: `${height}px` }}>
          {useGrafanaScrollbar && overflow === 'visible' ? (
            <CustomScrollbar autoHeightMin={'100%'}>
              <div ref={this.state.shadowContainerRef} />
            </CustomScrollbar>
          ) : (
            <div ref={this.state.shadowContainerRef} />
          )}
        </div>
        <Errors errors={this.state.errors} />
      </>
    );
  }

  onDataHover(hoverPayload: DataHoverPayload) {
    console.error('DataHover handler executing', hoverPayload);

    // First verify htmlNode is available
    if (!htmlNode) {
      console.error('htmlNode is not available');
      return;
    }

    console.error('DataHover handler executing', hoverPayload);

    // Now try to get the element
    const hoverTimeElem = htmlNode.getElementById('hover-time');

    // Make sure we have hover data and the element
    if (hoverPayload && hoverPayload.point && hoverTimeElem) {
      // Check if time is not null (important!)
      if (hoverPayload.point.time != null) {
        // Now TypeScript knows time is a number, not null
        const hoverTime = new Date(hoverPayload.point.time);
        console.error('Hover time:', hoverTime.toLocaleString());
        hoverTimeElem.textContent = hoverTime.toLocaleString();
      } else {
        hoverTimeElem.textContent = 'No time data in hover event';
        console.error('Time value is null in hover payload');
      }
    } else {
      console.error('Missing data:', {
        havePayload: !!hoverPayload,
        havePoint: !!(hoverPayload && hoverPayload.point),
        haveElement: !!hoverTimeElem,
      });
    }

    const errorObj: ErrorObj = {
      scope: 'onDataHover',
      isError: false,
    };

    const { onDataHover } = this.props.options;

    if (onDataHover) {
      try {
        const rawHtmlGraphics = this.getHtmlGraphics();
        const { htmlNode, data, codeData, options, theme } = rawHtmlGraphics;
        const htmlGraphics = this.htmlGraphics || rawHtmlGraphics;

        const F = new Function(
          'htmlNode',
          'data',
          'customProperties',
          'codeData',
          'options',
          'theme',
          'getTemplateSrv',
          'getLocationSrv',
          'htmlGraphics',
          'hoverPayload',
          onDataHover
        );
        // eslint-disable-next-line deprecation/deprecation
        F(
          htmlNode,
          data,
          codeData,
          codeData,
          options,
          theme,
          getTemplateSrv,
          getLocationSrv,
          htmlGraphics,
          hoverPayload
        );
      } catch (e) {
        errorObj.isError = true;
        errorObj.error = e;
        console.error(`onDataHover:`, e);
      }
    }

    this.updateError(errorObj);
  }

  onDataHoverClear() {
    // Optional: Implement hover clear logic
    // This could run code to hide tooltips when not hovering
  }

  // Replace the old handleDataHover method with this one
  handleDataHover = (event: DataHoverEvent) => {
    // Just store the payload for later use
    this.latestHoverPayload = event.payload;
  };

  // Add method to execute the onDataHover script
  executeDataHoverScript(hoverPayload: DataHoverPayload) {
    const errorObj: ErrorObj = {
      scope: 'onDataHover',
      isError: false,
    };

    try {
      const rawHtmlGraphics = this.getHtmlGraphics();
      const { htmlNode, data, codeData, options, theme } = rawHtmlGraphics;
      const htmlGraphics = this.htmlGraphics || rawHtmlGraphics;

      const F = new Function(
        'htmlNode',
        'data',
        'customProperties',
        'codeData',
        'options',
        'theme',
        'getTemplateSrv',
        'getLocationSrv',
        'htmlGraphics',
        'hoverPayload',
        this.props.options.onDataHover || ''
      );

      F(htmlNode, data, codeData, codeData, options, theme, getTemplateSrv, getLocationSrv, htmlGraphics, hoverPayload);
    } catch (e) {
      errorObj.isError = true;
      errorObj.error = e;
      console.error(`onDataHover execution error:`, e);
    }

    this.updateError(errorObj);
  }
}
