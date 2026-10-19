import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys, verifyResetToken } from '@/lib/queries'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldError } from '@/components/ui/field-error'
import { FormErrorCount } from '@/components/ui/form-error-count'
import { FieldHint } from '@/components/ui/field-hint'
import { PASSWORD_HINT, PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT, describedBy } from '@/lib/password'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const schema = z.object({
  password: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT),
  confirm: z.string(),
}).refine((d) => d.password === d.confirm, {
  message: 'Passwords do not match',
  path: ['confirm'],
})
type FormData = z.infer<typeof schema>

export function ResetPassword() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''

  const { register, handleSubmit, setError, formState: { errors, isSubmitting, submitCount } } = useForm<FormData>({
    shouldFocusError: false, // FormErrorCount focuses, once the field is described (#824)
    resolver: zodResolver(schema),
  })

  // Derived, and checked once per visit — see Invite, which has the same shape.
  const queryClient = useQueryClient()
  const verify = useQuery({
    queryKey: queryKeys.resetToken(token),
    queryFn: () => verifyResetToken(token),
    enabled: token !== '',
    staleTime: Infinity,
  })
  const status = !token || verify.isError ? 'invalid' : verify.isPending ? 'loading' : 'valid'

  async function onSubmit(data: FormData) {
    try {
      const res = await fetch('/api/v1/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: data.password }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: string }
        setError('root', { message: d.error ?? 'Failed to reset password' })
        return
      }
      // A used token is no longer valid; kept cached, going back would show its form again.
      queryClient.removeQueries({ queryKey: queryKeys.resetToken(token) })
      navigate('/login', { replace: true })
    } catch {
      setError('root', { message: 'Network error. Please try again.' })
    }
  }

  if (status === 'loading') return <div className="flex min-h-svh items-center justify-center" />

  if (status === 'invalid') {
    return (
      <div className="flex min-h-svh items-center justify-center overflow-hidden p-4">
        <Card level={4} className="w-full max-w-sm text-center">
          <CardHeader>
            <CardTitle>Link expired</CardTitle>
            <CardDescription>This password reset link is invalid or has expired. Ask your admin to send a new one.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-svh items-center justify-center overflow-hidden p-4">
      <Card level={4} className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>Reset password</CardTitle>
          <CardDescription>Enter your new password below.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="password">New password</Label>
              <Input id="password" type="password" aria-required="true" autoComplete="new-password" aria-invalid={!!errors.password} aria-describedby={describedBy('password-hint', 'password-error', !!errors.password)} {...register('password')} />
              {!errors.password && <FieldHint id="password-hint">{PASSWORD_HINT}</FieldHint>}
              <FieldError id="password-error" message={errors.password?.message} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input id="confirm" type="password" aria-required="true" autoComplete="new-password" aria-invalid={!!errors.confirm} aria-describedby={errors.confirm ? 'confirm-error' : undefined} {...register('confirm')} />
              <FieldError id="confirm-error" message={errors.confirm?.message} />
            </div>
            <FieldError assertive id="resetpassword-error" message={errors.root?.message} />
            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? 'Saving…' : 'Set new password'}
            </Button>
            <FormErrorCount errors={errors} submitCount={submitCount} />
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
