import "core-js/es6/promise";
import appConfig from "./config/appConfig";
import viewConfig from "./config/viewConfig";
import log from "./diag/logger";
import eventLog from "./diag/eventLog";
import pbia from "./diag/analytics";
import AuthBase from "./auth/authBase";
import {service, factories, Embed, IEmbedConfiguration, models, IEmbedSettings, Report} from "powerbi-client";
import AppBase from "./appBase";
import { XhrClient, RequestMethods, XhrRequestError } from "./services/xhrClient";

// https://github.com/Microsoft/PowerBI-JavaScript/wiki
// https://microsoft.github.io/PowerBI-JavaScript/

class PowerBiViewerApp extends AppBase {
    private _pbiContainer = document.getElementById("pbicontainer");
    private _activeReport: Embed = null;

    constructor() {
        super();
    }

    protected init(auth: AuthBase) {
        if (!this.validateViewConfig()) {
            return;
        }

        pbia.view(viewConfig.type, viewConfig.isPreview);

        if (appConfig.auto_refresh_token) {
            auth.authAboutToExpireCallback = () => {
                log.info("Token about to expire.");
                auth.getToken()
                    .then(token => {
                        log.info("Setting new token.");
                        this._activeReport.setAccessToken(token)
                            .catch(reason => {
                                // fallback to page reload
                                log.error("Failed setting token => " + reason);
                                location.reload();
                            }); }
                    ).catch(reason => {
                        // fallback to page reload
                        log.error("Failed getting renewal token => " + reason);
                        location.reload();
                    });
            };
        }

        this.loadCustomScripts()
            .then(() => this.loadView(auth))
            .catch(reason => this.setError());
    }

    private loadView(auth: AuthBase): void {
        auth.getToken()
            .then(token => {
                switch (viewConfig.type) {
                    case "tile": this.embedTile(token); break;
                    case "report": this.embedReport(token); break;
                    case "visual": this.embedVisual(token); break;
                    case "dashboard": this.embedDashboard(token); break;
                }
            })
            .catch(error => {
                eventLog.error("Authentication error: " + error);
                this.setError();
            });
    }

    private loadCustomScripts(): Promise<any> {
        if (appConfig.custom_scripts == null || !Array.isArray(appConfig.custom_scripts) || appConfig.custom_scripts.length === 0) {
            log.debug("No custom scripts to load");
            return Promise.resolve();
        }

        let promises: Promise<void>[] = [];
        appConfig.custom_scripts.forEach(url => {
            promises.push(
                XhrClient.send({
                    method: RequestMethods.Get,
                    url: url,
                    headers: {
                        "Accept": "*/*"
                    }
                }).then(result => {
                    let el = document.createElement("script");
                    el.type = "text/javascript";
                    el.text = result;
                    document.getElementsByTagName("head")[0].appendChild(el);
                }).catch((reason: XhrRequestError) => {
                    log.error(`Failed downloading script '${url}'. Error: '${reason.message}'. (${reason.status}): ${reason.statusText}`);
                    throw reason;
                }));
        });

        return Promise.all<void>(promises);
    }

    private validateViewConfig(): boolean {
        let isValid = true;
        if (viewConfig.id == null || viewConfig.id.length === 0) {
            eventLog.error("Missing id of item to show.");
            this.setError();
            isValid = false;
        }

        switch (viewConfig.type) {
            case "tile":
                if (viewConfig.dashboardId == null || viewConfig.dashboardId.length === 0) {
                    eventLog.error("Id of dashboard is required when displaying a tile.");
                    this.setError();
                    isValid = false;
                }
                break;
            case "visual":
                if (viewConfig.visualName == null || viewConfig.visualName.length === 0) {
                    eventLog.error("Name of Visual is required when displaying a report visual.");
                    this.setError();
                    isValid = false;
                }

                if (viewConfig.pageName == null || viewConfig.pageName.length === 0) {
                    eventLog.error("PageName is required when displaying a report visual.");
                    this.setError();
                    isValid = false;
                }
                break;
            case "report":
            case "dashboard":
                break;
            default:
                eventLog.error(`Invalid type '${viewConfig.type}'. Expected 'report', 'dashboard', or 'tile'.`);
                this.setError();
                isValid = false;
        }

        return isValid;
    }

    private getEmbedUrl(): string {
        let url = appConfig.embed_base_url;
        if (viewConfig.type === "report" || viewConfig.type === "visual") {
            url += `reportEmbed?reportId=${viewConfig.id}`;
        } else if (viewConfig.type === "dashboard") {
            url += `dashboardEmbed?dashboardId=${viewConfig.id}`;
        } else if (viewConfig.type === "tile") {
            url += `embed?dashboardId=${viewConfig.dashboardId}&tileId=${viewConfig.id}`;
        }

        if (viewConfig.groupId != null) {
            url += `&groupId=${viewConfig.groupId}`;
        }

        return url;
    }

    private embedTile(token: string): void {
        this.embedObject(this.createTileConfiguration(token));
    }

    private embedDashboard(token: string): void {
        this.embedObject(this.createDashboardConfiguration(token));
    }

    private embedVisual(token: string): void {
        this.embedObject(this.createVisualConfiguration(token));
    }

    private embedReport(token: string): void {
        this.embedObject(this.createReportConfiguration(token));
    }

    private embedObject(embedConfig: IEmbedConfiguration): void {
        try {
            if (viewConfig.filterFn != null) {
                log.debug(`Getting filters from function '${viewConfig.filterFn}'`);
                let filters = this.executeFunctionByName(viewConfig.filterFn);
                if (filters != null && Array.isArray(filters)) {
                    embedConfig.filters = filters;
                }
                else {
                    log.error(`Filter function named '${viewConfig.filterFn}' did not return an array of filters to apply`);
                }
            }

            log.debug("Next up: Embedconfig");
            log.debug(embedConfig);

            let powerbi = new service.Service(factories.hpmFactory, factories.wpmpFactory, factories.routerFactory);
            this._activeReport = powerbi.embed(this._pbiContainer, embedConfig);

            // If defined - call view-specific function with implementation-specific customizations (filtering, handling of events etc.)
            if (viewConfig.customFn != null) {
                this.executeFunctionByName(viewConfig.customFn, this._activeReport);
            }
        }
        catch (error) {
            eventLog.error(error);
            this.setError();
        }
    }

    private createTileConfiguration(token: string): IEmbedConfiguration {
        let embedConfig = this.createDashboardConfiguration(token);
        return embedConfig;
    }

    private createDashboardConfiguration(token: string): IEmbedConfiguration {
        let embedConfig = this.createBaseEmbedConfiguration(token);
        embedConfig.dashboardId = viewConfig.dashboardId;
        return embedConfig;
    }

    private createVisualConfiguration(token: string): IEmbedConfiguration {
        let embedConfig = this.createReportConfiguration(token);
        (<any>embedConfig).visualName = viewConfig.visualName;
        return embedConfig;
    }

    private createReportConfiguration(token: string): IEmbedConfiguration {
        let embedConfig = this.createBaseEmbedConfiguration(token);
        embedConfig.pageName = viewConfig.pageName,
        embedConfig.settings = {
            filterPaneEnabled: viewConfig.showFilterPane,
            navContentPaneEnabled: viewConfig.showNavPane,
            layoutType: models.LayoutType.Custom,
            customLayout: {
                displayOption: models.DisplayOption.FitToWidth
            }
        } as IEmbedSettings;

        return embedConfig;
    }

    private createBaseEmbedConfiguration(token: string): IEmbedConfiguration {
        return {
            viewMode: models.ViewMode.View,
            tokenType: models.TokenType.Aad,
            type: viewConfig.type,
            accessToken: token,
            embedUrl: this.getEmbedUrl(),
            id: viewConfig.id,
            permissions: models.Permissions.Read,
        } as IEmbedConfiguration;
    }

    private executeFunctionByName(functionName: string, ...args) {
        let argArray = [];
        args.forEach(a => argArray.push(a));

        log.info(`Calling custom function '${functionName}'`);
        let context = window;
        let namespaces = functionName.split(".");
        let func = namespaces.pop();
        for (let i = 0; i < namespaces.length; i++) {
            context = context[namespaces[i]];
        }

        return context[func].apply(context, argArray);
    }
}

(<any>window).PbiPreviewLogVisualsFn = (report: Report) => {
    report.on("loaded", () => {
        report.getPages()
        .then(allReportPages => {
            console.info(`Report contains ${allReportPages.length} pages.`);

            // Loop through all pages
            allReportPages.forEach(page => {
                console.info(`Getting visuals for page '${page.displayName}' [${page.name}].`);

                page.getVisuals()
                .then(pageVisuals => {
                    // Log all visuals found in the page
                    let pageVisualsInfo = {
                        Page: {
                            displayName: page.displayName,
                            name: page.name
                        },

                        Visuals: pageVisuals.map(visual => {
                            return {
                                name: visual.name,
                                title: visual.title,
                                type: visual.type
                            };
                        })
                    };

                    console.info(pageVisualsInfo);
                });
            });
        });
    });
};

// Let's get started
new PowerBiViewerApp().start();
