package constraints.generated.procedures;

import constraints.generated.AutoValueMappers;
import gov.nasa.ammos.plandev.contrib.serialization.rulesets.BasicValueMappers;
import gov.nasa.ammos.plandev.merlin.framework.ValueMapper;
import gov.nasa.ammos.plandev.merlin.protocol.model.InputType;
import gov.nasa.ammos.plandev.merlin.protocol.types.InstantiationException;
import gov.nasa.ammos.plandev.merlin.protocol.types.SerializedValue;
import gov.nasa.ammos.plandev.merlin.protocol.types.UnconstructableArgumentException;
import gov.nasa.ammos.plandev.merlin.protocol.types.ValueSchema;
import gov.nasa.ammos.plandev.procedural.constraints.ProcedureMapper;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class OnboardStorageFull implements ProcedureMapper<constraints.procedures.OnboardStorageFull> {
  @Override
  public ValueSchema valueSchema() {
    return AutoValueMappers.constraints_procedures_OnboardStorageFull(
            BasicValueMappers.$double()).getValueSchema();
  }

  @Override
  public InputType<constraints.procedures.OnboardStorageFull> getInputType() {
    return new InputMapper();
  }

  public final class InputMapper implements InputType<constraints.procedures.OnboardStorageFull> {
    private final ValueMapper<Double> mapper_fractionFull;

    @SuppressWarnings("unchecked")
    public InputMapper() {
      this.mapper_fractionFull =
          BasicValueMappers.$double();
    }

    @Override
    public List<String> getRequiredParameters() {
      return List.of();
    }

    @Override
    public ArrayList<InputType.Parameter> getParameters() {
      final var parameters = new ArrayList<InputType.Parameter>();
      parameters.add(new InputType.Parameter("fractionFull", this.mapper_fractionFull.getValueSchema()));
      return parameters;
    }

    @Override
    public Map<String, SerializedValue> getArguments(
        final constraints.procedures.OnboardStorageFull input) {
      final var arguments = new HashMap<String, SerializedValue>();
      arguments.put("fractionFull", this.mapper_fractionFull.serializeValue(input.fractionFull()));
      return arguments;
    }

    @Override
    public constraints.procedures.OnboardStorageFull instantiate(
        final Map<String, SerializedValue> arguments) throws InstantiationException {
      Optional<Double> fractionFull = Optional.empty();

      final var instantiationExBuilder = new InstantiationException.Builder("OnboardStorageFull");

      for (final var entry : arguments.entrySet()) {
        try {
          switch (entry.getKey()) {
            case "fractionFull":
              fractionFull = Optional.ofNullable(this.mapper_fractionFull.deserializeValue(entry.getValue())
                  .getSuccessOrThrow(failure -> new UnconstructableArgumentException("fractionFull", failure)));
              break;
            default:
              instantiationExBuilder.withExtraneousArgument(entry.getKey());
          }
        } catch (final UnconstructableArgumentException e) {
          instantiationExBuilder.withUnconstructableArgument(e.parameterName, e.failure);
        }
      }

      fractionFull.ifPresentOrElse(
          value -> instantiationExBuilder.withValidArgument("fractionFull", this.mapper_fractionFull.serializeValue(value)),
          () -> instantiationExBuilder.withMissingArgument("fractionFull", this.mapper_fractionFull.getValueSchema()));

      instantiationExBuilder.throwIfAny();
      return new constraints.procedures.OnboardStorageFull(fractionFull.get());
    }

    @Override
    public List<InputType.ValidationNotice> getValidationFailures(
        final constraints.procedures.OnboardStorageFull input) {
      final var notices = new ArrayList<InputType.ValidationNotice>();
      return notices;
    }
  }
}
