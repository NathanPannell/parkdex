// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { dispatchNativeBack } from "@/lib/native-back";
import { ACCOUNT_DELETION_CONFIRMATION, AccountDeletionDialog } from "./account-deletion-dialog";

afterEach(() => cleanup());

it("requires the exact destructive confirmation before calling the server callback", () => {
  const onDeleteAccount = vi.fn().mockResolvedValue({ photoCleanupPending: false });
  render(<AccountDeletionDialog accountEmail="explorer@example.com" onClose={vi.fn()} onDeleteAccount={onDeleteAccount} />);

  const deleteButton = screen.getByRole("button", { name: "Delete account" });
  expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/type DELETE to continue/i), { target: { value: "DELE" } });
  expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/type DELETE to continue/i), { target: { value: ACCOUNT_DELETION_CONFIRMATION } });
  expect((deleteButton as HTMLButtonElement).disabled).toBe(false);
  expect(onDeleteAccount).not.toHaveBeenCalled();
});

it("shows pending work and only shows server-confirmed success with photo cleanup detail", async () => {
  let resolve: (result: { photoCleanupPending: boolean; localCleanupPending?: boolean }) => void = () => undefined;
  const onDeleteAccount = vi.fn(() => new Promise<{ photoCleanupPending: boolean; localCleanupPending?: boolean }>((finish) => { resolve = finish; }));
  render(<AccountDeletionDialog accountEmail="explorer@example.com" onClose={vi.fn()} onDeleteAccount={onDeleteAccount} />);

  fireEvent.change(screen.getByLabelText(/type DELETE to continue/i), { target: { value: ACCOUNT_DELETION_CONFIRMATION } });
  fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
  expect(onDeleteAccount).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toMatch(/waiting for the server/i);
  expect((screen.getByRole("button", { name: /deleting account/i }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("heading", { name: "Account deleted" })).toBeNull();

  await act(async () => { resolve({ photoCleanupPending: true, localCleanupPending: true }); });
  await waitFor(() => expect(screen.getByRole("heading", { name: "Account deleted" })).toBeTruthy());
  expect(screen.getAllByRole("status").map((status) => status.textContent)).toEqual(expect.arrayContaining([
    expect.stringMatching(/queued for deletion/i),
    expect.stringMatching(/device data still needs cleanup/i),
  ]));
});

it("keeps keyboard focus inside the dialog while deletion is pending", async () => {
  let resolve: (result: { photoCleanupPending: boolean }) => void = () => undefined;
  const onClose = vi.fn();
  const onDeleteAccount = vi.fn(() => new Promise<{ photoCleanupPending: boolean }>((finish) => { resolve = finish; }));
  render(<AccountDeletionDialog accountEmail="explorer@example.com" onClose={onClose} onDeleteAccount={onDeleteAccount} />);

  fireEvent.change(screen.getByLabelText(/type DELETE to continue/i), { target: { value: ACCOUNT_DELETION_CONFIRMATION } });
  fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("dialog"));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { resolve({ photoCleanupPending: false }); });
});

it("keeps the dialog open and reports a failed deletion", async () => {
  const onDeleteAccount = vi.fn().mockRejectedValue(new Error("The server could not delete this account."));
  render(<AccountDeletionDialog accountEmail="explorer@example.com" onClose={vi.fn()} onDeleteAccount={onDeleteAccount} />);

  fireEvent.change(screen.getByLabelText(/type DELETE to continue/i), { target: { value: ACCOUNT_DELETION_CONFIRMATION } });
  fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
  expect((await screen.findByRole("alert")).textContent).toContain("The server could not delete this account.");
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Account deleted" })).toBeNull();
});

it("uses Escape and native Back as safe closes while idle", async () => {
  const onClose = vi.fn();
  render(<AccountDeletionDialog accountEmail="explorer@example.com" onClose={onClose} onDeleteAccount={vi.fn()} />);

  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  onClose.mockClear();
  expect(dispatchNativeBack()).toBe(false);
  expect(onClose).toHaveBeenCalledTimes(1);
});
