export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      contacts: {
        Row: {
          created_at: string
          decision_maker_source: string | null
          email: string | null
          email_source: string | null
          email_verified: boolean | null
          firm_id: string
          full_name: string | null
          hubspot_contact_id: string | null
          id: string
          is_decision_maker: boolean | null
          last_synced_at: string | null
          linkedin_url: string | null
          title: string | null
          unsubscribed: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          decision_maker_source?: string | null
          email?: string | null
          email_source?: string | null
          email_verified?: boolean | null
          firm_id: string
          full_name?: string | null
          hubspot_contact_id?: string | null
          id?: string
          is_decision_maker?: boolean | null
          last_synced_at?: string | null
          linkedin_url?: string | null
          title?: string | null
          unsubscribed?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          decision_maker_source?: string | null
          email?: string | null
          email_source?: string | null
          email_verified?: boolean | null
          firm_id?: string
          full_name?: string | null
          hubspot_contact_id?: string | null
          id?: string
          is_decision_maker?: boolean | null
          last_synced_at?: string | null
          linkedin_url?: string | null
          title?: string | null
          unsubscribed?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_firm_id_fkey"
            columns: ["firm_id"]
            isOneToOne: false
            referencedRelation: "firms"
            referencedColumns: ["id"]
          },
        ]
      }
      firms: {
        Row: {
          city: string | null
          county: string | null
          created_at: string
          custody_evidence_url: string | null
          domain: string | null
          firm_size_band: string | null
          fit_score: number | null
          handles_custody: boolean | null
          headcount_est: number | null
          hubspot_company_id: string | null
          hubspot_deal_id: string | null
          id: string
          last_synced_at: string | null
          name: string
          score_breakdown: Json | null
          source: string
          state: string | null
          status: Database["public"]["Enums"]["pipeline_status"]
          updated_at: string
          uses_practice_mgmt: string | null
        }
        Insert: {
          city?: string | null
          county?: string | null
          created_at?: string
          custody_evidence_url?: string | null
          domain?: string | null
          firm_size_band?: string | null
          fit_score?: number | null
          handles_custody?: boolean | null
          headcount_est?: number | null
          hubspot_company_id?: string | null
          hubspot_deal_id?: string | null
          id?: string
          last_synced_at?: string | null
          name: string
          score_breakdown?: Json | null
          source: string
          state?: string | null
          status?: Database["public"]["Enums"]["pipeline_status"]
          updated_at?: string
          uses_practice_mgmt?: string | null
        }
        Update: {
          city?: string | null
          county?: string | null
          created_at?: string
          custody_evidence_url?: string | null
          domain?: string | null
          firm_size_band?: string | null
          fit_score?: number | null
          handles_custody?: boolean | null
          headcount_est?: number | null
          hubspot_company_id?: string | null
          hubspot_deal_id?: string | null
          id?: string
          last_synced_at?: string | null
          name?: string
          score_breakdown?: Json | null
          source?: string
          state?: string | null
          status?: Database["public"]["Enums"]["pipeline_status"]
          updated_at?: string
          uses_practice_mgmt?: string | null
        }
        Relationships: []
      }
      inbound_signups: {
        Row: {
          created_at: string
          current_tool: string | null
          email: string
          firm_name: string | null
          firm_size: string | null
          form: string | null
          id: string
          matched_contact_id: string | null
          matched_firm_id: string | null
          persona: string
          routed_to: string | null
          source_id: string
          source_system: string
          state: string | null
          utm: Json | null
        }
        Insert: {
          created_at?: string
          current_tool?: string | null
          email: string
          firm_name?: string | null
          firm_size?: string | null
          form?: string | null
          id?: string
          matched_contact_id?: string | null
          matched_firm_id?: string | null
          persona?: string
          routed_to?: string | null
          source_id: string
          source_system: string
          state?: string | null
          utm?: Json | null
        }
        Update: {
          created_at?: string
          current_tool?: string | null
          email?: string
          firm_name?: string | null
          firm_size?: string | null
          form?: string | null
          id?: string
          matched_contact_id?: string | null
          matched_firm_id?: string | null
          persona?: string
          routed_to?: string | null
          source_id?: string
          source_system?: string
          state?: string | null
          utm?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "inbound_signups_matched_contact_id_fkey"
            columns: ["matched_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_signups_matched_firm_id_fkey"
            columns: ["matched_firm_id"]
            isOneToOne: false
            referencedRelation: "firms"
            referencedColumns: ["id"]
          },
        ]
      }
      job_locks: {
        Row: {
          acquired_at: string
          expires_at: string
          holder: string
          name: string
        }
        Insert: {
          acquired_at?: string
          expires_at: string
          holder: string
          name: string
        }
        Update: {
          acquired_at?: string
          expires_at?: string
          holder?: string
          name?: string
        }
        Relationships: []
      }
      outreach_drafts: {
        Row: {
          body: string | null
          contact_id: string
          created_at: string
          id: string
          prompt_version: string | null
          reviewed_at: string | null
          sent_at: string | null
          status: string
          subject: string | null
          updated_at: string
        }
        Insert: {
          body?: string | null
          contact_id: string
          created_at?: string
          id?: string
          prompt_version?: string | null
          reviewed_at?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Update: {
          body?: string | null
          contact_id?: string
          created_at?: string
          id?: string
          prompt_version?: string | null
          reviewed_at?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outreach_drafts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_events: {
        Row: {
          created_at: string
          entity: string
          entity_id: string | null
          id: number
          idempotency_key: string | null
          payload: Json | null
          type: string
        }
        Insert: {
          created_at?: string
          entity: string
          entity_id?: string | null
          id?: never
          idempotency_key?: string | null
          payload?: Json | null
          type: string
        }
        Update: {
          created_at?: string
          entity?: string
          entity_id?: string | null
          id?: never
          idempotency_key?: string | null
          payload?: Json | null
          type?: string
        }
        Relationships: []
      }
      research: {
        Row: {
          created_at: string
          evidence: Json | null
          firm_id: string
          id: string
          model: string
          output: Json
          prompt_version: string
        }
        Insert: {
          created_at?: string
          evidence?: Json | null
          firm_id: string
          id?: string
          model: string
          output: Json
          prompt_version: string
        }
        Update: {
          created_at?: string
          evidence?: Json | null
          firm_id?: string
          id?: string
          model?: string
          output?: Json
          prompt_version?: string
        }
        Relationships: [
          {
            foreignKeyName: "research_firm_id_fkey"
            columns: ["firm_id"]
            isOneToOne: false
            referencedRelation: "firms"
            referencedColumns: ["id"]
          },
        ]
      }
      suppressions: {
        Row: {
          created_at: string
          email: string
          reason: string
          source: string
        }
        Insert: {
          created_at?: string
          email: string
          reason: string
          source: string
        }
        Update: {
          created_at?: string
          email?: string
          reason?: string
          source?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acquire_job_lock: {
        Args: { p_holder: string; p_name: string; p_ttl_seconds: number }
        Returns: boolean
      }
      apply_clay_callback: {
        Args: {
          p_custody_evidence_url: string
          p_dropped_people: Json
          p_firm_id: string
          p_firm_size_band: string
          p_handles_custody: boolean
          p_headcount: number
          p_idempotency_key: string
          p_people: Json
          p_raw: Json
        }
        Returns: Json
      }
      import_firms: {
        Args: { p_firms: Json; p_import_id: string; p_source: string }
        Returns: {
          domain: string
          id: string
        }[]
      }
      release_job_lock: {
        Args: { p_holder: string; p_name: string }
        Returns: boolean
      }
    }
    Enums: {
      pipeline_status:
        | "new"
        | "sent_to_clay"
        | "enriched"
        | "researched"
        | "scored"
        | "qualified"
        | "disqualified"
        | "synced"
        | "drafted"
        | "contacted"
        | "replied"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      pipeline_status: [
        "new",
        "sent_to_clay",
        "enriched",
        "researched",
        "scored",
        "qualified",
        "disqualified",
        "synced",
        "drafted",
        "contacted",
        "replied",
      ],
    },
  },
} as const
