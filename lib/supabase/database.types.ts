export type Product = Database['public']['Tables']['products']['Row'];

export type InventoryMovement = Database['public']['Tables']['inventory_movements']['Row'];

export type ProductCost = Database['public']['Tables']['product_costs']['Row'];

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          user_id: string;
          display_name: string | null;
          role: string;
          created_at: string;
        };
        Insert: {
          user_id: string;
          display_name?: string | null;
          role?: string;
          created_at?: string;
        };
        Update: {
          display_name?: string | null;
          role?: string;
        };
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          product_code: string;
          barcode: string | null;
          name: string;
          unit: string;
          unit_price_cents: number;
          stock_quantity: number;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          product_code: string;
          barcode?: string | null;
          name: string;
          unit?: string;
          unit_price_cents: number;
          stock_quantity?: number;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          product_code?: string;
          barcode?: string | null;
          name?: string;
          unit?: string;
          unit_price_cents?: number;
          active?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      product_costs: {
        Row: {
          product_id: string;
          unit_cost_cents: number;
          updated_by: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      pricing_settings: {
        Row: {
          id: boolean;
          expected_monthly_revenue_cents: number;
          updated_at: string;
        };
        Insert: {
          id?: boolean;
          expected_monthly_revenue_cents?: number;
          updated_at?: string;
        };
        Update: {
          expected_monthly_revenue_cents?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      payment_settings: {
        Row: {
          id: boolean;
          pix_payment_mode: string;
          pix_key: string;
          merchant_name: string;
          merchant_city: string;
          updated_by: string | null;
          updated_at: string;
        };
        Insert: {
          id?: boolean;
          pix_payment_mode?: string;
          pix_key?: string;
          merchant_name?: string;
          merchant_city?: string;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: {
          pix_payment_mode?: string;
          pix_key?: string;
          merchant_name?: string;
          merchant_city?: string;
          updated_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      pricing_variable_fees: {
        Row: {
          id: string;
          name: string;
          rate_bps: number;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          rate_bps: number;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          name?: string;
          rate_bps?: number;
          active?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      pricing_fixed_expenses: {
        Row: {
          id: string;
          name: string;
          monthly_amount_cents: number;
          rate_bps: number;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          monthly_amount_cents: number;
          rate_bps: number;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          name?: string;
          monthly_amount_cents?: number;
          rate_bps?: number;
          active?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      purchase_invoices: {
        Row: {
          id: string;
          supplier_name: string;
          invoice_number: string;
          issue_date: string;
          total_cents: number;
          created_by: string;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      purchase_invoice_items: {
        Row: {
          id: string;
          invoice_id: string;
          product_id: string;
          product_code: string;
          product_name: string;
          quantity: number;
          unit_cost_cents: number;
          line_total_cents: number;
          expiration_date: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      invoice_payables: {
        Row: {
          invoice_id: string;
          due_date: string;
          tax_total_cents: number | null;
          boleto_reference: string | null;
          is_paid: boolean;
          paid_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      product_batches: {
        Row: {
          id: string;
          product_id: string;
          source_invoice_item_id: string | null;
          expiration_date: string | null;
          received_quantity: number;
          remaining_quantity: number;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      inventory_movements: {
        Row: {
          id: string;
          product_id: string;
          quantity_delta: number;
          reason: string;
          note: string | null;
          actor_user_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          product_id: string;
          quantity_delta: number;
          reason: string;
          note?: string | null;
          actor_user_id: string;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      sales: {
        Row: {
          id: string;
          total_cents: number;
          payment_method: string;
          amount_received_cents: number;
          change_cents: number;
          created_by: string;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      sale_items: {
        Row: {
          id: string;
          sale_id: string;
          product_id: string;
          product_code: string;
          product_name: string;
          quantity: number;
          unit_price_cents: number;
          discount_bps: number;
          subtotal_cents: number;
          discount_cents: number;
          total_cents: number;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      has_inventory_write_access: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      record_stock_movement: {
        Args: {
          p_product_id: string;
          p_quantity: number;
          p_reason: string;
          p_note?: string | null;
        };
        Returns: InventoryMovement;
      };
      save_product_pricing: {
        Args: {
          p_product_id: string;
          p_unit_cost_cents: number;
          p_variable_expense_bps: number;
          p_tax_bps: number;
          p_target_profit_bps: number;
        };
        Returns: number;
      };
      save_product_pricing_at_desired_price: {
        Args: {
          p_product_id: string;
          p_unit_cost_cents: number;
          p_desired_price_cents: number;
        };
        Returns: number;
      };
      record_stock_movement_with_expiry: {
        Args: {
          p_product_id: string;
          p_quantity: number;
          p_reason: string;
          p_note?: string | null;
          p_expiration_date?: string | null;
          p_source_invoice_item_id?: string | null;
        };
        Returns: InventoryMovement;
      };
      record_purchase_invoice: {
        Args: {
          p_supplier_name: string;
          p_invoice_number: string;
          p_issue_date: string;
          p_lines: Array<{
            product_id: string;
            quantity: number;
            unit_cost_cents: number;
            expiration_date: string | null;
          }>;
        };
        Returns: string;
      };
      record_purchase_invoice_with_markup: {
        Args: {
          p_supplier_name: string;
          p_invoice_number: string;
          p_issue_date: string;
          p_lines: Json;
          p_apply_suggested_prices: boolean;
          p_target_profit_bps: number;
        };
        Returns: string;
      };
      update_invoice_payable: {
        Args: {
          p_invoice_id: string;
          p_due_date: string;
          p_tax_total_cents: number | null;
          p_boleto_reference: string | null;
        };
        Returns: undefined;
      };
      set_invoice_payable_paid: {
        Args: {
          p_invoice_id: string;
          p_is_paid: boolean;
        };
        Returns: undefined;
      };
      record_sale: {
        Args: {
          p_lines: Json;
          p_payment_method: string;
          p_amount_received_cents: number;
          p_installments: number;
        };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
