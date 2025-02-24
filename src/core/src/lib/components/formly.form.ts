import { Component, DoCheck, OnChanges, Input, SimpleChanges, Optional, EventEmitter, Output, OnDestroy, Attribute } from '@angular/core';
import { FormGroup, FormArray, FormGroupDirective } from '@angular/forms';
import { FormlyFieldConfig, FormlyFormOptions, FormlyFormOptionsCache } from './formly.field.config';
import { FormlyFormBuilder } from '../services/formly.form.builder';
import { FormlyConfig } from '../services/formly.config';
import { assignModelValue, isNullOrUndefined, wrapProperty, clone, defineHiddenProp } from '../utils';
import { Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

@Component({
  selector: 'formly-form',
  template: `
    <formly-field *ngFor="let field of fields"
      hide-deprecation
      [form]="field.form"
      [options]="field.options"
      [model]="field.model"
      [field]="field">
    </formly-field>
    <ng-content></ng-content>
  `,
  providers: [FormlyFormBuilder],
})
export class FormlyForm implements DoCheck, OnChanges, OnDestroy {
  @Input() form: FormGroup | FormArray;

  @Input()
  set model(model: any) { this._model = this.immutable ? clone(model) : model; }
  get model() { return this._model || {}; }

  @Input()
  set fields(fields: FormlyFieldConfig[]) { this._fields = this.immutable ? clone(fields) : fields; }
  get fields() { return this._fields || []; }

  @Input()
  set options(options: FormlyFormOptions) { this._options = this.immutable ? clone(options) : options; }
  get options() { return this._options; }

  @Output() modelChange = new EventEmitter<any>();

  private immutable = false;
  private _model: any;
  private _fields: FormlyFieldConfig[];
  private _options: FormlyFormOptions;
  private initialModel: any;
  private modelChangeSubs: Subscription[] = [];

  private enableCheckExprDebounce = false;
  private checkExpressionChange$ = this.modelChange.pipe(
    debounceTime(this.enableCheckExprDebounce ? 100 : 0),
  ).subscribe(() => {
    this.enableCheckExprDebounce = true;
    this.checkExpressionChange();
    this.enableCheckExprDebounce = false;
  });

  constructor(
    private formlyBuilder: FormlyFormBuilder,
    private formlyConfig: FormlyConfig,
    // tslint:disable-next-line
    @Attribute('immutable') immutable,
    @Optional() private parentFormGroup: FormGroupDirective,
  ) {
    this.immutable = (immutable !== null) || !!formlyConfig.extras.immutable;
  }

  ngDoCheck() {
    if (this.formlyConfig.extras.checkExpressionOn === 'changeDetectionCheck') {
      this.checkExpressionChange();
    }
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes.fields || changes.form || changes.model) {
      this.form = this.form || (new FormGroup({}));
      this.setOptions();
      this.clearModelSubscriptions();
      this.formlyBuilder.buildForm(this.form, this.fields, this.model, this.options);
      this.trackModelChanges(this.fields);
      this.options.updateInitialValue();
    }
  }

  ngOnDestroy() {
    this.clearModelSubscriptions();
    this.checkExpressionChange$.unsubscribe();
  }

  changeModel(event: { key: string, value: any }) {
    assignModelValue(this.model, event.key.split('.'), event.value);
    this.modelChange.emit(clone(this.model));
  }

  setOptions() {
    if (!this.options) {
      this.options = {};
    }

    if (!this.options.resetModel) {
      this.options.resetModel = (model ?: any) => {
        model = isNullOrUndefined(model) ? this.initialModel : model;
        if (this.model) {
          Object.keys(this.model).forEach(k => delete this.model[k]);
          Object.assign(this.model, model || {});
        }

        (<FormlyFormOptionsCache> this.options)._buildForm();

        // we should call `NgForm::resetForm` to ensure changing `submitted` state after resetting form
        // but only when the current component is a root one.
        if (this.options.parentForm && this.options.parentForm.control === this.form) {
          this.options.parentForm.resetForm(model);
        } else {
          this.form.reset(model);
        }
      };
    }

    if (!this.options.parentForm && this.parentFormGroup) {
      defineHiddenProp(this.options, 'parentForm', this.parentFormGroup);
      wrapProperty(this.options.parentForm, 'submitted', (newVal, oldVal) => {
        if (newVal !== !!oldVal) {
          (<FormlyFormOptionsCache> this.options)._markForCheck({
            fieldGroup: this.fields,
            model: this.model,
            formControl: this.form,
            options: this.options,
          });
        }
      });
    }

    if (!this.options.updateInitialValue) {
      this.options.updateInitialValue = () => this.initialModel = clone(this.model);
    }

    if (!(<FormlyFormOptionsCache> this.options)._buildForm) {
      (<FormlyFormOptionsCache> this.options)._buildForm = (emitModelChange = false) => {
        this.clearModelSubscriptions();
        this.formlyBuilder.buildForm(this.form, this.fields, this.model, this.options);
        this.trackModelChanges(this.fields);

        if (emitModelChange) {
          this.modelChange.emit(clone(this.model));
        }
      };
    }
  }

  private checkExpressionChange() {
    if (this.options && (<FormlyFormOptionsCache> this.options)._checkField) {
      (<FormlyFormOptionsCache> this.options)._checkField({
        fieldGroup: this.fields,
        model: this.model,
        formControl: this.form,
        options: this.options,
      });
    }
  }

  private trackModelChanges(fields: FormlyFieldConfig[], rootKey: string[] = []) {
    fields.forEach(field => {
      if (field.key && !field.fieldGroup) {
        const valueChanges = field.modelOptions.debounce && field.modelOptions.debounce.default
          ? field.formControl.valueChanges.pipe(debounceTime(field.modelOptions.debounce.default))
          : field.formControl.valueChanges;

        this.modelChangeSubs.push(valueChanges.subscribe(value => {
          if (field.parsers && field.parsers.length > 0) {
            field.parsers.forEach(parserFn => value = parserFn(value));
          }

          this.changeModel({ key: [...rootKey, field.key].join('.'), value });
        }));
      }

      if (field.fieldGroup && field.fieldGroup.length > 0) {
        this.trackModelChanges(field.fieldGroup, field.key ? [...rootKey, field.key] : rootKey);
      }
    });
  }

  private clearModelSubscriptions() {
    this.modelChangeSubs.forEach(sub => sub.unsubscribe());
    this.modelChangeSubs = [];
  }
}
