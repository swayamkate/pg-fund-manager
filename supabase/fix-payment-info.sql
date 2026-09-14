-- PG Manager — Migration: add payment_info column to beds table
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- Safe to run multiple times; the ALTER only fires if the column is missing.

ALTER TABLE beds ADD COLUMN IF NOT EXISTS payment_info JSONB DEFAULT '{}'::jsonb;
