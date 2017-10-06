/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as json from 'vs/base/common/json';
import { StrictResourceMap } from 'vs/base/common/map';
import * as arrays from 'vs/base/common/arrays';
import * as objects from 'vs/base/common/objects';
import URI from 'vs/base/common/uri';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationRegistry, Extensions, OVERRIDE_PROPERTY_PATTERN } from 'vs/platform/configuration/common/configurationRegistry';
import { IOverrides, overrideIdentifierFromKey, addToValueTree, toValuesTree, IConfiguraionModel, merge, getConfigurationValue, IConfigurationOverrides, IConfigurationData, getDefaultValues, getConfigurationKeys } from 'vs/platform/configuration/common/configuration';
import { Workspace } from 'vs/platform/workspace/common/workspace';

export class ConfigurationModel implements IConfiguraionModel {

	constructor(protected _contents: any = {}, protected _keys: string[] = [], protected _overrides: IOverrides[] = []) {
	}

	public get contents(): any {
		return this._contents;
	}

	public get overrides(): IOverrides[] {
		return this._overrides;
	}

	public get keys(): string[] {
		return this._keys;
	}

	public getContentsFor<V>(section: string): V {
		return objects.clone(this.contents[section]);
	}

	public override<V>(identifier: string): ConfigurationModel {
		const result = new ConfigurationModel();
		const contents = objects.clone<any>(this.contents);
		if (this._overrides) {
			for (const override of this._overrides) {
				if (override.identifiers.indexOf(identifier) !== -1) {
					merge(contents, override.contents, true);
				}
			}
		}
		result._contents = contents;
		return result;
	}

	public setValue(key: string, value: any) {
		addToValueTree(this._contents, key, value, e => { throw new Error(e); });
		if (this._keys.indexOf(key) === -1) {
			this._keys.push(key);
		}
	}

	public removeValue(key: string) {
		// Remove key from the value tree
		const index = this._keys.indexOf(key);
		if (index !== -1) {
			this._keys.splice(index, 1);
		}
	}

	public merge(other: ConfigurationModel, overwrite: boolean = true): ConfigurationModel {
		const mergedModel = new ConfigurationModel();
		this.doMerge(mergedModel, this, overwrite);
		this.doMerge(mergedModel, other, overwrite);
		return mergedModel;
	}

	protected doMerge(source: ConfigurationModel, target: ConfigurationModel, overwrite: boolean = true) {
		merge(source.contents, objects.clone(target.contents), overwrite);
		const overrides = objects.clone(source._overrides);
		for (const override of target._overrides) {
			const [sourceOverride] = overrides.filter(o => arrays.equals(o.identifiers, override.identifiers));
			if (sourceOverride) {
				merge(sourceOverride.contents, override.contents, overwrite);
			} else {
				overrides.push(override);
			}
		}
		source._overrides = overrides;
	}
}

export class DefaultConfigurationModel extends ConfigurationModel {

	constructor() {
		super(getDefaultValues());
		this._keys = getConfigurationKeys();
		this._overrides = Object.keys(this._contents)
			.filter(key => OVERRIDE_PROPERTY_PATTERN.test(key))
			.map(key => {
				return <IOverrides>{
					identifiers: [overrideIdentifierFromKey(key).trim()],
					contents: toValuesTree(this._contents[key], message => console.error(`Conflict in default settings file: ${message}`))
				};
			});
	}

	public get keys(): string[] {
		return this._keys;
	}
}

interface Overrides extends IOverrides {
	raw: any;
}

export class CustomConfigurationModel extends ConfigurationModel {

	protected _parseErrors: any[] = [];

	constructor(content: string = '', private name: string = '') {
		super();
		if (content) {
			this.update(content);
		}
	}

	public get errors(): any[] {
		return this._parseErrors;
	}

	public update(content: string): void {
		let parsed: any = {};
		let overrides: Overrides[] = [];
		let currentProperty: string = null;
		let currentParent: any = [];
		let previousParents: any[] = [];
		let parseErrors: json.ParseError[] = [];

		function onValue(value: any) {
			if (Array.isArray(currentParent)) {
				(<any[]>currentParent).push(value);
			} else if (currentProperty) {
				currentParent[currentProperty] = value;
			}
			if (OVERRIDE_PROPERTY_PATTERN.test(currentProperty)) {
				onOverrideSettingsValue(currentProperty, value);
			}
		}

		function onOverrideSettingsValue(property: string, value: any): void {
			overrides.push({
				identifiers: [overrideIdentifierFromKey(property).trim()],
				raw: value,
				contents: null
			});
		}

		let visitor: json.JSONVisitor = {
			onObjectBegin: () => {
				let object = {};
				onValue(object);
				previousParents.push(currentParent);
				currentParent = object;
				currentProperty = null;
			},
			onObjectProperty: (name: string) => {
				currentProperty = name;
			},
			onObjectEnd: () => {
				currentParent = previousParents.pop();
			},
			onArrayBegin: () => {
				let array: any[] = [];
				onValue(array);
				previousParents.push(currentParent);
				currentParent = array;
				currentProperty = null;
			},
			onArrayEnd: () => {
				currentParent = previousParents.pop();
			},
			onLiteralValue: onValue,
			onError: (error: json.ParseErrorCode) => {
				parseErrors.push({ error: error });
			}
		};
		if (content) {
			try {
				json.visit(content, visitor);
				parsed = currentParent[0] || {};
			} catch (e) {
				console.error(`Error while parsing settings file ${this.name}: ${e}`);
				this._parseErrors = [e];
			}
		}
		this.processRaw(parsed);

		const configurationProperties = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties();
		this._overrides = overrides.map<IOverrides>(override => {
			// Filter unknown and non-overridable properties
			const raw = {};
			for (const key in override.raw) {
				if (configurationProperties[key] && configurationProperties[key].overridable) {
					raw[key] = override.raw[key];
				}
			}
			return {
				identifiers: override.identifiers,
				contents: toValuesTree(raw, message => console.error(`Conflict in settings file ${this.name}: ${message}`))
			};
		});
	}

	protected processRaw(raw: any): void {
		this._contents = toValuesTree(raw, message => console.error(`Conflict in settings file ${this.name}: ${message}`));
		this._keys = Object.keys(raw);
	}
}

export class Configuration {

	private _globalConfiguration: ConfigurationModel;
	private _workspaceConsolidatedConfiguration: ConfigurationModel;
	protected _foldersConsolidatedConfigurations: StrictResourceMap<ConfigurationModel>;
	protected _memoryConsolidatedConfigurations: StrictResourceMap<ConfigurationModel>;

	constructor(protected _defaults: ConfigurationModel,
		protected _user: ConfigurationModel,
		protected _workspaceConfiguration: ConfigurationModel = new ConfigurationModel(),
		protected folders: StrictResourceMap<ConfigurationModel> = new StrictResourceMap<ConfigurationModel>(),
		protected _memoryConfiguration: ConfigurationModel = new ConfigurationModel(),
		protected _memoryConfigurationByResource: StrictResourceMap<ConfigurationModel> = new StrictResourceMap<ConfigurationModel>(),
		protected _workspace?: Workspace) {
		this.merge();
	}

	get defaults(): ConfigurationModel {
		return this._defaults;
	}

	get user(): ConfigurationModel {
		return this._user;
	}

	get workspace(): ConfigurationModel {
		return this._workspaceConfiguration;
	}

	protected merge(): void {
		this._globalConfiguration = this._defaults.merge(this._user);
		this._workspaceConsolidatedConfiguration = this._globalConfiguration.merge(this._workspaceConfiguration);
		this._foldersConsolidatedConfigurations = new StrictResourceMap<ConfigurationModel>();
		for (const folder of this.folders.keys()) {
			this.mergeFolder(folder);
		}
	}

	protected mergeFolder(folder: URI) {
		this._foldersConsolidatedConfigurations.set(folder, this._workspaceConsolidatedConfiguration.merge(this.folders.get(folder)));
	}

	protected mergeMemory(folder: URI) {
		this._foldersConsolidatedConfigurations.set(folder, this._workspaceConsolidatedConfiguration.merge(this.folders.get(folder)));
	}

	getValue<C>(section: string = '', overrides: IConfigurationOverrides = {}): C {
		const configModel = this.getConsolidateConfigurationModel(overrides);
		return section ? configModel.getContentsFor<C>(section) : configModel.contents;
	}

	getValue2(key: string, overrides: IConfigurationOverrides = {}): any {
		// make sure to clone the configuration so that the receiver does not tamper with the values
		const consolidateConfigurationModel = this.getConsolidateConfigurationModel(overrides);
		return objects.clone(getConfigurationValue<any>(consolidateConfigurationModel.contents, key));
	}

	updateValue(key: string, value: any, overrides: IConfigurationOverrides = {}): void {
		let memoryConfiguration: ConfigurationModel;
		if (overrides.resource) {
			let memoryConfiguration = this._memoryConfigurationByResource.get(overrides.resource);
			if (!memoryConfiguration) {
				memoryConfiguration = new ConfigurationModel();
				this._memoryConfigurationByResource.set(overrides.resource, memoryConfiguration);
			}
		} else {
			memoryConfiguration = this._memoryConfiguration;
		}
		if (value === void 0) {
			memoryConfiguration.removeValue(key);
		} else {
			memoryConfiguration.setValue(key, value);
		}
	}

	lookup<C>(key: string, overrides: IConfigurationOverrides = {}): {
		default: C,
		user: C,
		workspace: C,
		workspaceFolder: C
		memory?: C
		value: C,
	} {
		// make sure to clone the configuration so that the receiver does not tamper with the values
		const consolidateConfigurationModel = this.getConsolidateConfigurationModel(overrides);
		const folderConfigurationModel = this.getFolderConfigurationModelForResource(overrides.resource);
		const memoryConfigurationModel = overrides.resource ? this._memoryConfigurationByResource.get(overrides.resource) || this._memoryConfiguration : this._memoryConfiguration;
		return {
			default: objects.clone(getConfigurationValue<C>(overrides.overrideIdentifier ? this._defaults.override(overrides.overrideIdentifier).contents : this._defaults.contents, key)),
			user: objects.clone(getConfigurationValue<C>(overrides.overrideIdentifier ? this._user.override(overrides.overrideIdentifier).contents : this._user.contents, key)),
			workspace: objects.clone(this._workspace ? getConfigurationValue<C>(overrides.overrideIdentifier ? this._workspaceConfiguration.override(overrides.overrideIdentifier).contents : this._workspaceConfiguration.contents, key) : void 0), //Check on workspace exists or not because _workspaceConfiguration is never null
			workspaceFolder: objects.clone(folderConfigurationModel ? getConfigurationValue<C>(overrides.overrideIdentifier ? folderConfigurationModel.override(overrides.overrideIdentifier).contents : folderConfigurationModel.contents, key) : void 0),
			memory: objects.clone(getConfigurationValue<C>(overrides.overrideIdentifier ? memoryConfigurationModel.override(overrides.overrideIdentifier).contents : memoryConfigurationModel.contents, key)),
			value: objects.clone(getConfigurationValue<C>(consolidateConfigurationModel.contents, key))
		};
	}

	keys(): {
		default: string[];
		user: string[];
		workspace: string[];
		workspaceFolder: string[];
	} {
		const folderConfigurationModel = this.getFolderConfigurationModelForResource();
		return {
			default: this._defaults.keys,
			user: this._user.keys,
			workspace: this._workspaceConfiguration.keys,
			workspaceFolder: folderConfigurationModel ? folderConfigurationModel.keys : []
		};
	}

	private getConsolidateConfigurationModel<C>(overrides: IConfigurationOverrides): ConfigurationModel {
		let configurationModel = this.getConsolidatedConfigurationModelForResource(overrides);
		return overrides.overrideIdentifier ? configurationModel.override(overrides.overrideIdentifier) : configurationModel;
	}

	private getConsolidatedConfigurationModelForResource({ resource }: IConfigurationOverrides): ConfigurationModel {
		if (!this._workspace) {
			return this._globalConfiguration;
		}

		if (!resource) {
			return this._workspaceConsolidatedConfiguration.merge(this._memoryConfiguration);
		}

		let consolidateConfiguration = this._workspaceConsolidatedConfiguration;
		const root = this._workspace.getFolder(resource);
		if (root) {
			consolidateConfiguration = this._foldersConsolidatedConfigurations.get(root.uri) || this._workspaceConsolidatedConfiguration;
		}

		const memoryConfigurationForResource = this._memoryConfigurationByResource.get(resource);
		if (memoryConfigurationForResource) {
			consolidateConfiguration = consolidateConfiguration.merge(memoryConfigurationForResource);
		}

		return consolidateConfiguration;
	}

	private getFolderConfigurationModelForResource(resource?: URI): ConfigurationModel {
		if (!this._workspace || !resource) {
			return null;
		}

		const root = this._workspace.getFolder(resource);
		return root ? this.folders.get(root.uri) : null;
	}

	public toData(): IConfigurationData {
		return {
			defaults: {
				contents: this._defaults.contents,
				overrides: this._defaults.overrides,
				keys: this._defaults.keys
			},
			user: {
				contents: this._user.contents,
				overrides: this._user.overrides,
				keys: this._user.keys
			},
			workspace: {
				contents: this._workspaceConfiguration.contents,
				overrides: this._workspaceConfiguration.overrides,
				keys: this._workspaceConfiguration.keys
			},
			folders: this.folders.keys().reduce((result, folder) => {
				const { contents, overrides, keys } = this.folders.get(folder);
				result[folder.toString()] = { contents, overrides, keys };
				return result;
			}, Object.create({}))
		};
	}

	public static parse(data: IConfigurationData, workspace: Workspace): Configuration {
		const defaultConfiguration = Configuration.parseConfigurationModel(data.defaults);
		const userConfiguration = Configuration.parseConfigurationModel(data.user);
		const workspaceConfiguration = Configuration.parseConfigurationModel(data.workspace);
		const folders: StrictResourceMap<ConfigurationModel> = Object.keys(data.folders).reduce((result, key) => {
			result.set(URI.parse(key), Configuration.parseConfigurationModel(data.folders[key]));
			return result;
		}, new StrictResourceMap<ConfigurationModel>());
		return new Configuration(defaultConfiguration, userConfiguration, workspaceConfiguration, folders, new ConfigurationModel(), new StrictResourceMap<ConfigurationModel>(), workspace);
	}

	private static parseConfigurationModel(model: IConfiguraionModel): ConfigurationModel {
		return new ConfigurationModel(model.contents, model.keys, model.overrides);
	}
}