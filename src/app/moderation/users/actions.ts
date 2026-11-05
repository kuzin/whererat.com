"use server";

import { MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MODERATOR_SESSION_COOKIE } from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";
import { createStoredModerator, updateUserByOwner, deleteUserById } from "@/lib/user-store";
import { persistImageFile } from "@/lib/media-storage";

const MAX_AVATAR_UPLOAD_BYTES = 8 * 1024 * 1024;

async function requireOwner() {
    const cookieStore = await cookies();
    const session = await verifyModeratorSession(
        cookieStore.get(MODERATOR_SESSION_COOKIE)?.value,
    );
    if (!session || session.role !== "owner") {
        redirect("/moderation");
    }
    return session;
}

export async function createUserAction(formData: FormData) {
    await requireOwner();
    const username = (formData.get("username") as string | null)?.trim().toLowerCase() ?? "";
    const name = (formData.get("name") as string | null)?.trim() ?? "";
    const email = (formData.get("email") as string | null)?.trim() ?? "";
    const password = (formData.get("password") as string | null)?.trim() ?? "";
    const role = (formData.get("role") as string | null) === "owner" ? "owner" : "moderator";
    const currentAvatarUrl = (formData.get("currentAvatarUrl") as string | null)?.trim() || null;

    const avatarFile = formData.get("avatarImage");
    const uploadedAvatarUrl =
        avatarFile instanceof File && avatarFile.size > 0
            ? await persistImageFile(avatarFile, { folder: "avatars", maxBytes: MAX_AVATAR_UPLOAD_BYTES })
            : undefined;
    const avatarUrl = uploadedAvatarUrl ?? (currentAvatarUrl || undefined);

    if (!username || !name || !email || !password) {
        redirect("/moderation/users?create=1&error=missing");
    }

    if (password.length < 6 || password.length > MAX_PASSWORD_LENGTH) {
        redirect("/moderation/users?create=1&error=weak_password");
    }

    const result = await createStoredModerator({ username, name, email, password, role, avatarUrl });
    if (!result.success) {
        redirect(`/moderation/users?create=1&error=${result.error}`);
    }

    revalidatePath("/moderation/users");
    redirect("/moderation/users?toast=user-created");
}

export async function updateUserAction(formData: FormData) {
    await requireOwner();
    const userId = (formData.get("userId") as string | null)?.trim() ?? "";
    const name = (formData.get("name") as string | null)?.trim() ?? "";
    const email = (formData.get("email") as string | null)?.trim() ?? "";
    const role = (formData.get("role") as string | null) === "owner" ? "owner" : "moderator";
    const newPassword = (formData.get("password") as string | null)?.trim() ?? "";
    const currentAvatarUrl = (formData.get("currentAvatarUrl") as string | null)?.trim() || null;

    const avatarFile = formData.get("avatarImage");
    const uploadedAvatarUrl =
        avatarFile instanceof File && avatarFile.size > 0
            ? await persistImageFile(avatarFile, { folder: "avatars", maxBytes: MAX_AVATAR_UPLOAD_BYTES })
            : undefined;
    const avatarUrl = uploadedAvatarUrl ?? (currentAvatarUrl || undefined);

    if (!userId || !name || !email) {
        redirect(`/moderation/users?edit=${userId}&error=missing`);
    }

    if (newPassword && (newPassword.length < 6 || newPassword.length > MAX_PASSWORD_LENGTH)) {
        redirect(`/moderation/users?edit=${userId}&error=weak_password`);
    }

    const result = await updateUserByOwner({
        userId,
        name,
        email,
        role,
        avatarUrl,
        newPassword: newPassword || undefined,
    });

    if (!result.success) {
        redirect(`/moderation/users?edit=${encodeURIComponent(userId)}&error=${result.error}`);
    }

    revalidatePath("/moderation/users");
    redirect("/moderation/users?toast=user-updated");
}

export async function deleteUserAction(formData: FormData) {
    const session = await requireOwner();
    const userId = (formData.get("userId") as string | null)?.trim() ?? "";
    if (!userId) redirect("/moderation/users");
    // The UI hides the button on your own row; enforce it on the server too.
    if (userId === session.id) redirect("/moderation/users?error=self_delete");

    const result = await deleteUserById(userId);
    if (!result.success) redirect(`/moderation/users?error=${result.error}`);
    revalidatePath("/moderation/users");
    redirect("/moderation/users?toast=user-deleted");
}
