import { z } from 'zod';

import { FormField as FormFieldType } from '@/shared/types/blocks/form';

/**
 * Pure (UI-free) Zod schema builders for the shared Form block.
 *
 * Kept out of `index.tsx` on purpose: that module pulls in Radix / react-hook-form
 * components whose import-time `React.createContext` calls break test files loaded
 * under `--conditions react-server`. This module only touches `zod` + the field
 * type, so validation logic can be unit-tested directly.
 */
export function buildFieldSchema(field: FormFieldType) {
  if (field.type === 'switch') {
    return z.boolean();
  }

  if (field.type === 'number') {
    // Accept both number (from initial data) and string (from input onChange)
    let schema = z.union([z.number(), z.string()]);

    // An optional number left blank must not run the numeric refinements:
    // Number('') is 0, which would fail a min constraint and block the
    // whole form even though the field was never filled in.
    const isBlankOptional = (val: unknown) =>
      !field.validation?.required &&
      (val === undefined || val === null || val === '');

    if (field.validation?.required) {
      schema = schema.refine(
        (val) => {
          if (val === null || val === undefined || val === '') {
            return false;
          }
          return true;
        },
        {
          message: field.validation.message || `${field.title} is required`,
        }
      );
    }

    // Validate that the value can be converted to a valid number
    schema = schema.refine(
      (val) => {
        if (isBlankOptional(val)) return true;
        const num = typeof val === 'number' ? val : Number(val);
        return !isNaN(num) && isFinite(num);
      },
      {
        message:
          field.validation?.message || `${field.title} must be a valid number`,
      }
    );

    // Apply min validation if specified
    if (field.validation?.min !== undefined) {
      schema = schema.refine(
        (val) => {
          if (isBlankOptional(val)) return true;
          const num = typeof val === 'number' ? val : Number(val);
          return num >= field.validation!.min!;
        },
        {
          message:
            field.validation?.message ||
            `${field.title} must be at least ${field.validation.min}`,
        }
      );
    }

    // Apply max validation if specified
    if (field.validation?.max !== undefined) {
      schema = schema.refine(
        (val) => {
          if (isBlankOptional(val)) return true;
          const num = typeof val === 'number' ? val : Number(val);
          return num <= field.validation!.max!;
        },
        {
          message:
            field.validation?.message ||
            `${field.title} must be at most ${field.validation.max}`,
        }
      );
    }

    return schema;
  }

  if (
    field.type === 'upload_image' &&
    field.metadata?.max &&
    field.metadata.max > 1
  ) {
    let arraySchema = z.array(z.string());

    if (field.validation?.required) {
      arraySchema = arraySchema.min(1, {
        message: field.validation.message || `${field.title} is required`,
      });
    }

    return arraySchema;
  }

  if (field.type === 'checkbox') {
    let schema = z.array(z.string());

    // A checkbox group that is genuinely required must reject an empty array;
    // otherwise the red star is a lie. Note that roles/permissions are NOT
    // required: a normal user legitimately has zero roles, and demoting an
    // admin means clearing their last one.
    if (field.validation?.required) {
      schema = schema.min(1, {
        message: field.validation.message || `${field.title} is required`,
      });
    }

    return schema;
  }

  if (field.type === 'upload_image') {
    let schema = z.string();

    if (field.validation?.required) {
      schema = schema.min(1, {
        message: field.validation.message || `${field.title} is required`,
      });
    }

    return schema;
  }

  let schema = z.string();

  if (field.validation?.required) {
    schema = schema.min(1, {
      message: field.validation.message || `${field.title} is required`,
    });
  }

  if (field.validation?.min) {
    schema = schema.min(field.validation.min, {
      message:
        field.validation.message ||
        `${field.title} must be at least ${field.validation.min} characters`,
    });
  }

  if (field.validation?.max) {
    schema = schema.max(field.validation.max, {
      message:
        field.validation.message ||
        `${field.title} must be at most ${field.validation.max} characters`,
    });
  }

  if (field.validation?.email) {
    schema = schema.email({
      message:
        field.validation.message || `${field.title} must be a valid email`,
    });
  }

  return schema;
}

export const generateFormSchema = (fields: FormFieldType[]) => {
  const schemaFields: Record<string, any> = {};

  fields.forEach((field) => {
    if (field.name) {
      schemaFields[field.name] = buildFieldSchema(field);
    }
  });

  return z.object(schemaFields);
};
