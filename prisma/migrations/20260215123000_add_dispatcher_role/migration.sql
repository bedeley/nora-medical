-- Add DISPATCHER role for mobile delivery workflow users
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'DISPATCHER';
